import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  HTTP_BASE,
  jsonRequest,
  makeHttpStore,
  useHttpDatastore,
} from "../../test/http-fixtures.js";
import * as store from "../store.js";
import { createHttpApp } from "./app.js";

describe("household and pantry HTTP routes", () => {
  const fixture = useHttpDatastore();
  const request = (route: string, init?: RequestInit) =>
    createHttpApp().request(`${HTTP_BASE}${route}`, init);

  it("reads a structured household", async () => {
    const res = await request("/api/household");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(makeHttpStore().household);
  });

  it("updates country and delegates schedule normalization and raw text to the service", async () => {
    const res = await request(
      "/api/household",
      jsonRequest(
        {
          country: "no",
          people: [
            { name: " Helle ", dietaryRestrictions: [], defaultSchedule: { monday: false } },
          ],
        },
        "PATCH",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      country: "NO",
      people: [{ name: " Helle ", defaultSchedule: { monday: false, sunday: true } }],
    });
    expect((await store.load()).household.country).toBe("NO");
  });

  it("rejects an invalid country without changing the datastore", async () => {
    const before = await fs.readFile(fixture.dataPath(), "utf8");
    const res = await request("/api/household", jsonRequest({ country: " DK " }, "PATCH"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_COUNTRY" } });
    expect(await fs.readFile(fixture.dataPath(), "utf8")).toBe(before);
  });

  it("preserves country-empty and defaultServings-zero omissions", async () => {
    const res = await request(
      "/api/household",
      jsonRequest({ country: "", defaultServings: 0 }, "PATCH"),
    );
    expect(await res.json()).toMatchObject({ country: "DK", defaultServings: 3 });
  });

  it("accepts raw unknown and duplicate stores and explicit negative servings", async () => {
    const stores = [
      { name: " unknown ", dealerId: " raw ", priority: -1 },
      { name: " unknown ", dealerId: " raw ", priority: -1 },
    ];
    const res = await request(
      "/api/household",
      jsonRequest({ stores, defaultServings: -1 }, "PATCH"),
    );
    expect(await res.json()).toMatchObject({ stores, defaultServings: -1 });
  });

  it("reads and updates pantry using case-insensitive remove-before-add semantics", async () => {
    await store.save(makeHttpStore({ pantry: ["Salt", "Peber"] }));
    expect(await (await request("/api/pantry")).json()).toEqual({ items: ["Salt", "Peber"] });
    const res = await request(
      "/api/pantry",
      jsonRequest({ add: ["salt", "salt", " Olie "], remove: ["SALT"] }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [" Olie ", "Peber", "salt"] });
  });

  it("delegates an empty pantry request to the existing no-op write/sort path", async () => {
    await store.save(makeHttpStore({ pantry: ["z", "A"] }));
    const update = vi.spyOn(store, "updatePantry");
    const res = await request("/api/pantry", jsonRequest({}, "PATCH"));
    expect(await res.json()).toEqual({ items: ["A", "z"] });
    expect(update).toHaveBeenCalledExactlyOnceWith([], []);
  });

  it.each([
    "{",
    "null",
    '{"add":[1]}',
  ])("rejects invalid request body %s without writes", async (body) => {
    const update = vi.spyOn(store, "updatePantry");
    const res = await request("/api/pantry", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toMatch(/^INVALID_/);
    expect(update).not.toHaveBeenCalled();
  });

  it("maps a busy datastore to 503", async () => {
    vi.spyOn(store, "updatePantry").mockRejectedValueOnce(new store.DatastoreBusyError());
    const res = await request("/api/pantry", jsonRequest({}, "PATCH"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "DATASTORE_BUSY", message: "Datastore is busy; try again shortly." },
    });
  });

  it("maps corrupt persisted JSON to 500, not request validation, without leaking paths", async () => {
    await fs.writeFile(fixture.dataPath(), "broken json", "utf8");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request("/api/household");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    });
    expect(await fs.readFile(fixture.dataPath(), "utf8")).toBe("broken json");
  });

  it("rejects foreign origins before any mutation and does not enable CORS", async () => {
    const update = vi.spyOn(store, "updatePantry");
    const init = jsonRequest({ add: ["bad"] }, "PATCH");
    const res = await request("/api/pantry", {
      ...init,
      headers: { ...init.headers, origin: "https://example.com" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects browser form/text content types before mutation", async () => {
    const update = vi.spyOn(store, "updatePantry");
    const res = await request("/api/pantry", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
