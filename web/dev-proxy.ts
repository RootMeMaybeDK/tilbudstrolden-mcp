import type { IncomingHttpHeaders } from "node:http";
import type { Connect, Plugin, ProxyOptions } from "vite";

export const WEB_PORT = 5173;
export const API_TARGET = "http://127.0.0.1:3000";

export function isLocalWebRequest(headers: IncomingHttpHeaders): boolean {
  const { host, origin } = headers;
  return (
    (host === `127.0.0.1:${WEB_PORT}` || host === `localhost:${WEB_PORT}`) &&
    (origin === undefined || origin === `http://${host}`) &&
    headers["sec-fetch-site"] !== "cross-site"
  );
}

// Runs before Vite's proxy, including for mutations. Never blindly erase an untrusted Origin.
export const localRequestGuard: Connect.NextHandleFunction = (req, res, next) => {
  if (!isLocalWebRequest(req.headers)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ error: { code: "FORBIDDEN_ORIGIN", message: "Local requests only." } }),
    );
    return;
  }
  next();
};

export function localWebGuard(): Plugin {
  return {
    name: "local-web-origin-guard",
    configureServer(server) {
      server.middlewares.use(localRequestGuard);
    },
    configurePreviewServer(server) {
      server.middlewares.use(localRequestGuard);
    },
  };
}

export const apiProxy: ProxyOptions = {
  target: API_TARGET,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq, req) => {
      // The guard has verified the browser's origin. Backend remains strictly same-origin.
      if (req.headers.origin !== undefined) proxyReq.setHeader("origin", API_TARGET);
    });
  },
};
