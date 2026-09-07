import { describe, expect, it, vi } from "vitest";
import {
  HTTP_BASE,
  jsonRequest,
  makeHttpOffer,
  makeHttpRecipe,
  makeHttpStore,
  useHttpDatastore,
} from "../../test/http-fixtures.js";
import * as api from "../api.js";
import * as store from "../store.js";
import { createHttpApp } from "./app.js";

const appleRecipe = makeHttpRecipe({
  name: "Apples",
  proteinType: "vegetarian",
  cuisineType: "danish",
  ingredients: [{ name: "Æbler", quantity: "1 kg", searchTerms: ["æbler"], category: "produce" }],
});
function deals() {
  return new Map([
    ["hakket oksekød", [makeHttpOffer()]],
    [
      "æbler",
      [makeHttpOffer({ id: "apple", heading: "Æbler", price: 20, quantity: 1, unit: "kg" })],
    ],
  ]);
}

describe("plan-and-shop HTTP route", () => {
  useHttpDatastore();
  const request = (body: unknown) =>
    createHttpApp().request(`${HTTP_BASE}/api/plan-and-shop`, jsonRequest(body));

  it("runs the real planner and shopping service with exactly one deal batch fetch", async () => {
    await store.save(makeHttpStore({ recipes: [makeHttpRecipe(), appleRecipe] }));
    const batch = vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(deals());
    const res = await request({ days: 2 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      days: 2,
      householdSize: 3,
      country: "DK",
      currency: "DKK",
      constraints: { maxPerProtein: 2, maxPerCuisine: 2, maxSlowDays: 2 },
    });
    expect(
      body.plan.map((d: { day: number; recipeName: string }) => [d.day, d.recipeName]),
    ).toEqual([
      [1, "Apples"],
      [2, "Chili"],
    ]);
    expect(body.plan[0].matchedDealEstimate).toBe(15);
    expect(body.planningEstimate.matchedDealPlanningEstimate).toBe(45);
    expect(body.selectedRecipes.map((r: { name: string }) => r.name)).toEqual(["Chili", "Apples"]);
    expect(body.shopping.selectedRecipes).toEqual(body.selectedRecipes);
    expect(body.shopping.priceSummary.matchedPurchaseSubtotal).toBe(60);
    expect(body.shopping.items[0].selectedOffer).toMatchObject({ storeId: "n1", price: 40 });
    expect(JSON.stringify(body)).not.toMatch(/dealMap|synonymMap|ingredientTags|estimatedCost|##/);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("reuses an empty cached deal map without retrying through shopping", async () => {
    const batch = vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(new Map());
    const res = await request({ days: 1 });
    expect(res.status).toBe(200);
    expect((await res.json()).shopping.items[0]).toMatchObject({
      confidence: "none",
      selectedOffer: null,
      matchedPurchaseSubtotal: null,
    });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("applies people override to both scoring and shopping without persisting it", async () => {
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(deals());
    const body = await (await request({ days: 1, people: 6 })).json();
    expect(body.householdSize).toBe(6);
    expect(body.plan[0].matchedDealEstimate).toBe(60);
    expect(body.shopping).toMatchObject({
      householdSize: 6,
      items: [
        {
          quantity: { aggregated: { totalAmount: 750, unit: "g" } },
          purchase: { packsNeeded: 2, totalCost: 80 },
        },
      ],
    });
    expect((await store.load()).household.defaultServings).toBe(3);
  });

  it("passes variety and exclusion constraints through to the planner", async () => {
    await store.save(makeHttpStore({ recipes: [makeHttpRecipe(), appleRecipe] }));
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(deals());
    const constraints = {
      maxPerProtein: 1,
      maxPerCuisine: 1,
      maxSlowDays: 0,
      excludeProteins: ["beef"],
      slowOnlyOnDays: [6, 7],
      preferCuisines: { danish: 1 },
    };
    const res = await request({ days: 1, ...constraints });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.constraints).toEqual(constraints);
    expect(body.plan[0].recipeName).toBe("Apples");
  });

  it("maps insufficient recipes to 422 with default days and context", async () => {
    const batch = vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(deals());
    const res = await request({});
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({
      error: { code: "INSUFFICIENT_RECIPES" },
      result: {
        status: "insufficient-recipes",
        days: 7,
        availableRecipeCount: 1,
        householdSize: 3,
      },
    });
    expect(body.result).not.toHaveProperty("shopping");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("maps impossible variety constraints to 422 without building shopping", async () => {
    await store.save(
      makeHttpStore({ recipes: [makeHttpRecipe(), makeHttpRecipe({ name: "Second beef" })] }),
    );
    const batch = vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(deals());
    const res = await request({ days: 2, maxPerProtein: 1 });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({
      error: { code: "NO_VALID_PLAN" },
      result: { status: "no-valid-plan" },
    });
    expect(body.result).not.toHaveProperty("shopping");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid wire types before scoring", async () => {
    const batch = vi.spyOn(api, "searchDealsBatch");
    expect((await request({ days: "3" })).status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
  });

  it("maps busy and upstream errors through the common error contract", async () => {
    vi.spyOn(store, "getHousehold").mockRejectedValueOnce(new store.DatastoreBusyError());
    expect((await request({ days: 1 })).status).toBe(503);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(api, "searchDealsBatch").mockRejectedValueOnce(new Error("upstream"));
    const res = await request({ days: 1 });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
