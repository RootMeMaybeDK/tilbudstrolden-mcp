// @vitest-environment node
import { createServer, request, type Server } from "node:http";
import { createServer as createViteServer } from "vite";
import { describe, expect, it } from "vitest";
import { API_TARGET, apiProxy, isLocalWebRequest, localWebGuard } from "./dev-proxy";
import config from "./vite.config";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  return address.port;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("localhost dev proxy", () => {
  it("keeps fixed loopback targets and same-origin CORS policy", () => {
    expect(API_TARGET).toBe("http://127.0.0.1:3000");
    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      cors: false,
    });
    expect(config.preview).toMatchObject({
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      cors: false,
    });
    expect(config.server?.proxy).toEqual({ "^/api(?:/|$)": apiProxy });
  });

  it.each([
    { host: "evil.test:5173" },
    { host: "127.0.0.1:5173", origin: "http://evil.test" },
    { host: "127.0.0.1:5173", origin: "null" },
    { host: "127.0.0.1:5173", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:5174" },
    {},
  ])("rejects unsafe headers %j", (headers) => {
    expect(isLocalWebRequest(headers)).toBe(false);
  });

  it.each(["127.0.0.1", "localhost"])("accepts same-origin %s", (host) => {
    expect(
      isLocalWebRequest({
        host: `${host}:5173`,
        origin: `http://${host}:5173`,
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(true);
    expect(isLocalWebRequest({ host: `${host}:5173` })).toBe(true);
  });

  it("actually proxies GET and POST with verified origin and rejects foreign requests before upstream", async () => {
    const received: { url?: string; origin?: string; body: string }[] = [];
    const upstream = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({ url: req.url, origin: req.headers.origin, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: "tilbudstrolden" }));
    });
    const upstreamPort = await listen(upstream);
    const vite = await createViteServer({
      configFile: false,
      plugins: [localWebGuard()],
      server: {
        middlewareMode: true,
        ws: false,
        proxy: { "^/api(?:/|$)": { ...apiProxy, target: `http://127.0.0.1:${upstreamPort}` } },
      },
    });
    const frontend = createServer(vite.middlewares);
    try {
      const port = await listen(frontend);
      async function call(method: string, origin?: string) {
        return new Promise<number | undefined>((resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/health",
              method,
              headers: { host: "127.0.0.1:5173", ...(origin ? { origin } : {}) },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            },
          );
          req.on("error", reject);
          req.end(method === "POST" ? '{"test":true}' : undefined);
        });
      }
      expect(await call("GET")).toBe(200);
      expect(await call("POST", "http://127.0.0.1:5173")).toBe(200);
      expect(await call("POST", "http://evil.test")).toBe(403);
      expect(received).toEqual([
        { url: "/api/health", origin: undefined, body: "" },
        { url: "/api/health", origin: API_TARGET, body: '{"test":true}' },
      ]);
    } finally {
      await vite.close();
      await close(frontend);
      await close(upstream);
    }
  });
});
