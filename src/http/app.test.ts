import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./app.js";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

describe("HTTP app", () => {
  it("returns a stable JSON health response without upstream calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const response = await createHttpApp().request("http://127.0.0.1:3000/api/health");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ status: "ok", service: "tilbudstrolden" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("returns 404 for an unknown route", async () => {
    expect((await createHttpApp().request("http://127.0.0.1:3000/missing")).status).toBe(404);
  });

  it("does not open a listener when constructing or requesting the app", async () => {
    const { serve } = await import("@hono/node-server");
    await createHttpApp().request("http://127.0.0.1:3000/api/health");
    expect(serve).not.toHaveBeenCalled();
  });
});
