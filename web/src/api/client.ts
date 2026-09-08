import type { HealthHttpResponse } from "../../../src/contracts/http";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: JsonValue;
  signal?: AbortSignal;
};
type ErrorKind = "http" | "network" | "timeout" | "aborted" | "protocol";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly status: number | null = null,
    readonly code?: string,
    readonly result?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpError(status: number, data: unknown): ApiError {
  const envelope = record(data) ? data : undefined;
  const error = record(envelope?.error) ? envelope.error : undefined;
  return new ApiError(
    typeof error?.message === "string" ? error.message : `HTTP-fejl (${status}).`,
    "http",
    status,
    typeof error?.code === "string" ? error.code : undefined,
    envelope?.result,
  );
}

function decodeResponse(response: Response, text: string, empty: boolean): unknown {
  let data: unknown;
  try {
    data = text === "" ? undefined : JSON.parse(text);
  } catch {
    if (!response.ok) throw httpError(response.status, undefined);
    throw new ApiError("Backend returnerede ikke gyldig JSON.", "protocol", response.status);
  }
  if (!response.ok) throw httpError(response.status, data);
  if (empty) return;
  if (data === undefined)
    throw new ApiError("Backend returnerede et tomt svar.", "protocol", response.status);
  return data;
}

/** No automatic retries, including reads. In particular POST /spend can commit before a
 * currency read fails: a failed response is NOT evidence that the write was rolled back.
 * Future forms must disable double-submit and offer history refresh before a manual retry. */
export function createApiClient(basePath = "/api", timeoutMs = 60_000) {
  if (!/^\/(?!\/)[\w/-]*$/.test(basePath)) throw new Error("API base must be a relative path.");
  const base = basePath.replace(/\/$/, "");

  async function request<T>(path: string, options?: RequestOptions): Promise<T>;
  async function request(
    path: string,
    options: RequestOptions & { response: "empty" },
  ): Promise<void>;
  async function request<T>(
    path: string,
    options: RequestOptions & { response?: "empty" } = {},
  ): Promise<T | undefined> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) {
      throw new Error("API endpoint must be a relative path.");
    }
    const url = `${base}${path}`;
    // Reject dot-segment escapes; all requests must stay within the API base.
    if (!new URL(url, "http://local.invalid").pathname.startsWith(`${base}/`)) {
      throw new Error("API endpoint must stay within its base path.");
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin",
        redirect: "error",
        signal,
      });
      text = await response.text();
    } catch {
      if (options.signal?.aborted) throw new ApiError("Anmodningen blev afbrudt.", "aborted");
      if (timeout.aborted) throw new ApiError("Backend svarede ikke i tide.", "timeout");
      throw new ApiError("Kunne ikke kontakte backend.", "network");
    }
    // Single JSON trust boundary. T is the shared wire contract, not runtime schema validation.
    return decodeResponse(response, text, options.response === "empty") as T | undefined;
  }

  return { request };
}

export const api = createApiClient();

export async function getHealth(signal?: AbortSignal): Promise<HealthHttpResponse> {
  const health = await api.request<HealthHttpResponse>("/health", { signal });
  if (!record(health) || health.status !== "ok" || health.service !== "tilbudstrolden") {
    throw new ApiError("Backend returnerede en ukendt health-status.", "protocol");
  }
  return health;
}
