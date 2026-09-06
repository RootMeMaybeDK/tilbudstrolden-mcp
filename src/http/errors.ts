import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { DatastoreBusyError } from "../store.js";

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Catch only request parsing failures here; datastore parse errors are server errors. */
export async function parseJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.output<T>> {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HTTPException(400, {
      res: c.json(errorBody("INVALID_REQUEST", "Content-Type must be application/json."), 400),
    });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, {
      res: c.json(errorBody("INVALID_JSON", "Request body must contain valid JSON."), 400),
    });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      res: c.json(
        errorBody("INVALID_REQUEST", "Request body does not match the route schema."),
        400,
      ),
    });
  }
  return parsed.data;
}

export function handleHttpError(error: Error, c: Context) {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof DatastoreBusyError) {
    return c.json(errorBody("DATASTORE_BUSY", "Datastore is busy; try again shortly."), 503);
  }
  // Do not expose stack traces, datastore paths, or upstream details in responses.
  console.error("HTTP request failed:", error.name);
  return c.json(errorBody("INTERNAL_ERROR", "The request could not be completed."), 500);
}
