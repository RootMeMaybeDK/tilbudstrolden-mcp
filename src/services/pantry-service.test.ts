import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStore } from "../store.js";
import * as store from "../store.js";
import { updatePantryItems } from "./pantry-service.js";

function makeStore(pantry: string[] = []): DataStore {
  return {
    household: { people: [], stores: [], defaultServings: 2, country: "DK" },
    pantry,
    recipes: [],
    mealHistory: [],
    spendLog: [],
  };
}

describe("updatePantryItems", () => {
  let tempDirectory: string;
  let originalDataPath: string | undefined;

  beforeEach(async () => {
    originalDataPath = process.env.TILBUDSTROLDEN_DATA;
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-pantry-service-"));
    process.env.TILBUDSTROLDEN_DATA = path.join(tempDirectory, "data.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDataPath === undefined) delete process.env.TILBUDSTROLDEN_DATA;
    else process.env.TILBUDSTROLDEN_DATA = originalDataPath;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("delegates add/remove semantics and returns the final sorted pantry", async () => {
    await store.save(makeStore(["Salt", "peber"]));

    const result = await updatePantryItems({
      add: ["olie", "SALT", "olie"],
      remove: ["PEBER", "missing"],
    });

    expect(result).toEqual({ status: "updated", pantry: ["Salt", "olie"] });
    await expect(store.getPantry()).resolves.toEqual(["Salt", "olie"]);
  });

  it("removes before adding and preserves the added casing", async () => {
    await store.save(makeStore(["Salt"]));

    const result = await updatePantryItems({ add: ["salt"], remove: ["SALT"] });

    expect(result.pantry).toEqual(["salt"]);
  });

  it("accepts an empty string and preserves standard JavaScript sorting", async () => {
    await store.save(makeStore(["z"]));

    const result = await updatePantryItems({ add: ["", "A"], remove: [] });

    expect(result.pantry).toEqual(["", "A", "z"]);
  });

  it("delegates empty arrays without a pantry pre-read and retains sort behavior", async () => {
    await store.save(makeStore(["z", "A"]));
    const getPantry = vi.spyOn(store, "getPantry");

    const result = await updatePantryItems({ add: [], remove: [] });

    expect(result.pantry).toEqual(["A", "z"]);
    expect(getPantry).not.toHaveBeenCalled();
  });

  it("propagates the exact store error object", async () => {
    const error = new Error("permission denied");
    vi.spyOn(store, "updatePantry").mockRejectedValueOnce(error);

    await expect(updatePantryItems({ add: [], remove: [] })).rejects.toBe(error);
  });
});
