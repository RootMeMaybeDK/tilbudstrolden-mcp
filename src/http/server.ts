import path from "node:path";
import { serve } from "@hono/node-server";
import { createHttpApp } from "./app.js";

// HTTP must explicitly select its datastore rather than accidentally creating a new installation.
if (!process.env.TILBUDSTROLDEN_DATA || !path.isAbsolute(process.env.TILBUDSTROLDEN_DATA)) {
  throw new Error("HTTP startup requires TILBUDSTROLDEN_DATA to be an absolute datastore path.");
}

serve({ fetch: createHttpApp().fetch, hostname: "127.0.0.1", port: 3000 });
