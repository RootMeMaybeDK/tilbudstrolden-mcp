import { Hono } from "hono";

/** Construct the HTTP adapter without opening a network listener. */
export function createHttpApp() {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok", service: "tilbudstrolden" }));
  return app;
}
