import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { Offer } from "../src/api.js";
import type { DataStore, Recipe } from "../src/store.js";
import * as store from "../src/store.js";

export const HTTP_BASE = "http://127.0.0.1:3000";

export function makeHttpOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "beef", heading: "Hakket oksekød 8-12%", description: null,
    price: 40, prePrice: null, currency: "DKK", quantity: 500, unit: "g", pricePerUnit: "80.00 kr/kg",
    store: "Netto", storeId: "n1", validFrom: "2026-09-01", validUntil: "2026-09-30T00:00:00Z", imageUrl: null,
    ...overrides,
  };
}

export function jsonRequest(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function makeHttpRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "Chili", servings: 4, complexity: "medium", cuisineType: "mexican", proteinType: "beef",
    ingredients: [{ name: "Hakket oksekød", quantity: "500 g", searchTerms: ["hakket oksekød"], category: "meat" }],
    ...overrides,
  };
}

export function makeHttpStore(overrides: Partial<DataStore> = {}): DataStore {
  return {
    household: { people: [], stores: [{ name: "Netto", dealerId: "n1", priority: 1 }], defaultServings: 3, country: "DK" },
    pantry: [], recipes: [makeHttpRecipe()], mealHistory: [], spendLog: [], ...overrides,
  };
}

/** Each HTTP integration test owns an absolute temp path, never the user's datastore. */
export function useHttpDatastore() {
  let directory: string;
  let dataPath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-http-"));
    dataPath = path.join(directory, "data.json");
    if (!path.isAbsolute(dataPath) || path.dirname(directory) !== path.resolve(os.tmpdir())) {
      throw new Error("Unsafe HTTP test datastore path");
    }
    vi.stubEnv("TILBUDSTROLDEN_DATA", dataPath);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected live HTTP fetch in test"); }));
    await store.save(makeHttpStore());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  return { dataPath: () => dataPath };
}
