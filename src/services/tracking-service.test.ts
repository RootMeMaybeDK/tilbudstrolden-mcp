import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../store.js";
import { readMealHistory, readSpendHistory, recordMeal, recordSpend } from "./tracking-service.js";

describe("tracking service", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-tracking-"));
    vi.stubEnv("TILBUDSTROLDEN_DATA", path.join(directory, "data.json"));
    await store.save({
      household: { country: "FI", people: [], stores: [], defaultServings: 3 },
      pantry: [],
      recipes: [],
      mealHistory: [],
      spendLog: [],
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const meal = { date: "2026-09-07", recipe: " Chili ", people: [" Helle "] };
  const spend = {
    date: "2026-09-07",
    store: " Netto ",
    estimatedTotal: 40.5,
    items: 2,
    notes: " raw ",
  };

  it("preserves raw meal values and delegates same-date case-insensitive replacement", async () => {
    const household = vi.spyOn(store, "getHousehold");
    expect(await recordMeal(meal)).toEqual({ status: "logged", entry: meal });
    await recordMeal({ ...meal, recipe: " CHILI ", people: ["Julie"] });
    expect((await store.load()).mealHistory).toEqual([
      { ...meal, recipe: " CHILI ", people: ["Julie"] },
    ]);
    expect(household).not.toHaveBeenCalled();
  });

  it("appends spend unchanged and reads currency only after the write", async () => {
    const write = vi.spyOn(store, "logSpend");
    const household = vi.spyOn(store, "getHousehold");
    expect(await recordSpend(spend)).toEqual({
      status: "logged",
      entry: spend,
      currency: "EUR",
      currencySymbol: "€",
    });
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(household.mock.invocationCallOrder[0]);
    expect((await store.load()).spendLog).toEqual([spend]);
  });

  it("preserves the committed write when the subsequent currency read fails", async () => {
    const error = new SyntaxError("injected post-commit read failure");
    vi.spyOn(store, "getHousehold").mockRejectedValueOnce(error);
    await expect(recordSpend(spend)).rejects.toBe(error);
    expect((await store.load()).spendLog).toEqual([spend]);
  });

  it("does not read currency after a failed write and preserves error identity", async () => {
    const error = new store.DatastoreBusyError();
    vi.spyOn(store, "logSpend").mockRejectedValueOnce(error);
    const household = vi.spyOn(store, "getHousehold");
    await expect(recordSpend(spend)).rejects.toBe(error);
    expect(household).not.toHaveBeenCalled();
    expect((await store.load()).spendLog).toEqual([]);
  });

  it("propagates meal write failures unchanged", async () => {
    const error = new Error("permission denied");
    vi.spyOn(store, "logMeal").mockRejectedValueOnce(error);
    await expect(recordMeal(meal)).rejects.toBe(error);
  });

  it("delegates meal lookback without filtering or sorting again", async () => {
    const read = vi.spyOn(store, "getMealHistory").mockResolvedValueOnce([meal]);
    expect(await readMealHistory()).toEqual({ weeks: 4, entries: [meal] });
    expect(read).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("avoids a household read for empty spending history", async () => {
    const household = vi.spyOn(store, "getHousehold");
    expect(await readSpendHistory()).toEqual({ status: "empty", weeks: 8, entries: [] });
    expect(household).not.toHaveBeenCalled();
  });

  it("preserves totals and weekly averages using the requested lookback", async () => {
    const read = vi
      .spyOn(store, "getSpendLog")
      .mockResolvedValueOnce([spend, { ...spend, estimatedTotal: 19.5 }]);
    expect(await readSpendHistory(4)).toMatchObject({
      status: "ready",
      total: 60,
      averagePerWeek: 15,
      currency: "EUR",
      currencySymbol: "€",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(4);
  });
});
