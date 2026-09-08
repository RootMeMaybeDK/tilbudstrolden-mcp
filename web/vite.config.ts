import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiProxy, localWebGuard, WEB_PORT } from "./dev-proxy.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [localWebGuard(), react()],
  server: {
    host: "127.0.0.1",
    port: WEB_PORT,
    strictPort: true,
    cors: false,
    proxy: { "^/api(?:/|$)": apiProxy },
  },
  preview: { host: "127.0.0.1", port: WEB_PORT, strictPort: true, cors: false },
  build: { outDir: "dist", sourcemap: false },
});
