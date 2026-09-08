import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthHttpResponse } from "../../../src/contracts/http";
import { ApiError, createApiClient, getHealth } from "./client";

afterEach(() => vi.unstubAllGlobals());

function mockResponse(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("API client", () => {
  it("reads shared JSON contracts using a relative /api path", async () => {
    const health = { status: "ok", service: "tilbudstrolden" } satisfies HealthHttpResponse;
    const fetchMock = mockResponse(Response.json(health));
    expect(await getHealth()).toEqual(health);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/health",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("sends JSON bodies and preserves the structured error and result context", async () => {
    const result = { status: "no-valid-plan" };
    const fetchMock = mockResponse(
      Response.json(
        { error: { code: "NO_VALID_PLAN", message: "No plan." }, result },
        { status: 422 },
      ),
    );
    await expect(
      createApiClient().request("/plan-and-shop", { method: "POST", body: { days: 3 } }),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "http",
      status: 422,
      code: "NO_VALID_PLAN",
      message: "No plan.",
      result,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/plan-and-shop",
      expect.objectContaining({
        body: '{"days":3}',
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      }),
    );
  });

  it.each([
    500, 503,
  ])("never retries a possibly committed spend POST after HTTP %s", async (status) => {
    const fetchMock = mockResponse(
      Response.json(
        { error: { code: "INTERNAL_ERROR", message: "Failed after write." } },
        { status },
      ),
    );
    await expect(
      createApiClient().request("/spend", {
        method: "POST",
        body: { date: "2026-09-08", store: "Lidl", estimatedTotal: 35, items: 1 },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "POST"] as const)("does not retry %s on network failure", async (method) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network detail"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createApiClient().request("/spend", { method })).rejects.toMatchObject({
      kind: "network",
      status: null,
      message: "Kunne ikke kontakte backend.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports explicit no-body responses without pretending to return JSON", async () => {
    mockResponse(new Response(null, { status: 204 }));
    await expect(
      createApiClient().request("/future", { method: "DELETE", response: "empty" }),
    ).resolves.toBeUndefined();
  });

  it("rejects empty responses when a JSON contract is expected", async () => {
    mockResponse(new Response(null, { status: 204 }));
    await expect(getHealth()).rejects.toMatchObject({ kind: "protocol", status: 204 });
  });

  it("handles non-JSON errors without displaying HTML", async () => {
    mockResponse(new Response("<h1>Proxy failure</h1>", { status: 502 }));
    await expect(getHealth()).rejects.toMatchObject({
      kind: "http",
      status: 502,
      message: "HTTP-fejl (502).",
    });
  });

  it.each([
    "<html>not JSON</html>",
    '{"status":"wrong"}',
    "null",
  ])("rejects malformed health success: %s", async (body) => {
    mockResponse(new Response(body));
    await expect(getHealth()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("propagates cancellation without a retry", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason);
    vi.stubGlobal("fetch", fetchMock);
    await expect(getHealth(controller.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds an unresponsive request including its response body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createApiClient("/api", 5).request("/health")).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows a relative base abstraction", async () => {
    const fetchMock = mockResponse(Response.json({}));
    await createApiClient("/api/").request("/health");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/health");
  });

  it.each([
    "http://remote.test/api",
    "//remote.test/api",
  ])("rejects non-relative base %s", (base) => {
    expect(() => createApiClient(base)).toThrow("relative path");
  });

  it.each([
    "http://remote.test",
    "//remote.test",
    "/../spend",
    "/%2e%2e/spend",
    "/\\remote",
  ])("rejects escaping endpoint %s before fetching", async (path) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createApiClient().request(path)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
