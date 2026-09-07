import { describe, expect, it, vi } from "vitest";
import { HTTP_BASE, jsonRequest, useHttpDatastore } from "../../test/http-fixtures.js";
import * as store from "../store.js";
import { createHttpApp } from "./app.js";

describe("tracking HTTP routes", () => {
  useHttpDatastore();
  const request = (route: string, init?: RequestInit) =>
    createHttpApp().request(`${HTTP_BASE}${route}`, init);
  const today = () => new Date().toISOString().slice(0, 10);

  it("records a raw meal and preserves date/name upsert before reading history", async () => {
    const entry = { date: today(), recipe: " Chili ", people: [" Helle "] };
    const res = await request("/api/meals", jsonRequest(entry));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "logged", entry });
    await request("/api/meals", jsonRequest({ ...entry, recipe: " CHILI ", people: ["Julie"] }));
    expect(await (await request("/api/meal-history")).json()).toEqual({
      weeks: 4,
      entries: [{ ...entry, recipe: " CHILI ", people: ["Julie"] }],
    });
    expect((await store.load()).mealHistory).toHaveLength(1);
  });

  it("logs spend with empty notes default and exposes service history totals", async () => {
    const entry = { date: today(), store: " Netto ", estimatedTotal: 41.5, items: 2 };
    const res = await request("/api/spend", jsonRequest(entry));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "logged",
      entry: { ...entry, notes: "" },
      currency: "DKK",
      currencySymbol: "kr",
    });
    expect(await (await request("/api/spend-log?weeks=2")).json()).toMatchObject({
      status: "ready",
      weeks: 2,
      total: 41.5,
      averagePerWeek: 20.75,
      entries: [{ ...entry, notes: "" }],
    });
  });

  it("returns empty history without an unnecessary currency read", async () => {
    const household = vi.spyOn(store, "getHousehold");
    expect(await (await request("/api/spend-log")).json()).toEqual({
      status: "empty",
      weeks: 8,
      entries: [],
    });
    expect(household).not.toHaveBeenCalled();
  });

  it("preserves a committed spend even when the response's currency read fails", async () => {
    const entry = { date: today(), store: "Netto", estimatedTotal: 20, items: 1, notes: "" };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "getHousehold").mockRejectedValueOnce(new Error("post-write read"));
    const res = await request("/api/spend", jsonRequest(entry));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect((await store.load()).spendLog).toEqual([entry]);
  });

  it("retains zero-week permissiveness with a JSON-null non-finite average", async () => {
    await store.logSpend({
      date: today(),
      store: "Netto",
      estimatedTotal: 20,
      items: 1,
      notes: "",
    });
    const res = await request("/api/spend-log?weeks=0");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ weeks: 0, total: 20, averagePerWeek: null });
  });

  it("rejects invalid wire types and lookbacks without writes", async () => {
    const meal = vi.spyOn(store, "logMeal");
    const spend = vi.spyOn(store, "logSpend");
    expect(
      (await request("/api/meals", jsonRequest({ date: today(), recipe: "A", people: "Helle" })))
        .status,
    ).toBe(400);
    expect(
      (
        await request(
          "/api/spend",
          jsonRequest({ date: today(), store: "A", estimatedTotal: "20", items: 1 }),
        )
      ).status,
    ).toBe(400);
    expect((await request("/api/meal-history?weeks=nope")).status).toBe(400);
    expect((await request("/api/spend-log?weeks=nope")).status).toBe(400);
    expect(meal).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("maps datastore busy before any committed meal", async () => {
    vi.spyOn(store, "logMeal").mockRejectedValueOnce(new store.DatastoreBusyError());
    expect(
      (await request("/api/meals", jsonRequest({ date: today(), recipe: "A", people: [] }))).status,
    ).toBe(503);
    expect((await store.load()).mealHistory).toEqual([]);
  });
});
