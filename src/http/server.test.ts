import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("HTTP listener configuration", () => {
  it("binds only to 127.0.0.1:3000 regardless of host/port environment variables", async () => {
    vi.stubEnv("TILBUDSTROLDEN_DATA", "/tmp/unused-http-listener-test.json");
    vi.stubEnv("HOST", "0.0.0.0");
    vi.stubEnv("PORT", "4000");
    const { serve } = await import("@hono/node-server");
    await import("./server.js");
    expect(serve).toHaveBeenCalledExactlyOnceWith({
      fetch: expect.any(Function),
      hostname: "127.0.0.1",
      port: 3000,
    });
  });

  it.each([
    undefined,
    "",
    "relative.json",
  ])("refuses an implicit/relative datastore: %s", async (value) => {
    vi.stubEnv("TILBUDSTROLDEN_DATA", value);
    const { serve } = await import("@hono/node-server");
    await expect(import("./server.js")).rejects.toThrow("absolute datastore path");
    expect(serve).not.toHaveBeenCalled();
  });
});
