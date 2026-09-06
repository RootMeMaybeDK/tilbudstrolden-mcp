import { Hono } from "hono";
import { errorBody, handleHttpError } from "./errors.js";
import { registerHouseholdRoutes } from "./household-routes.js";
import { registerRecipeRoutes } from "./recipe-routes.js";

/** Construct the HTTP adapter without opening a network listener. */
export function createHttpApp() {
  const app = new Hono();
  app.onError(handleHttpError);
  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Route not found."), 404));
  // Loopback binding alone does not prevent browser requests from foreign origins or DNS rebinding.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const origin = c.req.header("origin");
    if (
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      url.port !== "3000" ||
      (origin !== undefined && origin !== url.origin) ||
      c.req.header("sec-fetch-site") === "cross-site"
    ) {
      return c.json(
        errorBody("FORBIDDEN_ORIGIN", "Only local same-origin requests are allowed."),
        403,
      );
    }
    await next();
  });
  app.get("/api/health", (c) => c.json({ status: "ok", service: "tilbudstrolden" }));
  registerHouseholdRoutes(app);
  registerRecipeRoutes(app);
  return app;
}
