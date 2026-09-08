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
import { generateShoppingList } from "../services/shopping-service.js";
import * as store from "../store.js";
import { createHttpApp } from "./app.js";
import { shoppingDto } from "./dto.js";

describe("shopping HTTP route", () => {
  useHttpDatastore();
  const request = (body: unknown) =>
    createHttpApp().request(`${HTTP_BASE}/api/shopping-list`, jsonRequest(body));

  it("preserves 0.375 stk lemon requirement and purchases one pack", async () => {
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({
            name: "Tomatrisotto",
            ingredients: [
              { name: "Citron", quantity: "0.5 stk", searchTerms: ["citron"], category: "produce" },
            ],
          }),
        ],
      }),
    );
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(
      new Map([
        ["citron", [makeHttpOffer({ heading: "Citron", price: 5, quantity: 1, unit: "stk" })]],
      ]),
    );
    const res = await request({ recipeNames: ["Tomatrisotto"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({
      confidence: "high",
      quantity: {
        displayQuantity: "0.375 stk",
        aggregated: { totalAmount: 0.375, unit: "stk" },
        contributions: [
          {
            recipeName: "Tomatrisotto",
            quantity: "0.5 stk",
            recipeServings: 4,
            scaledAmount: 0.375,
          },
        ],
      },
      purchase: {
        quantityNeeded: 0.375,
        packSize: 1,
        packsNeeded: 1,
        leftover: 0.625,
        totalCost: 5,
      },
      matchedPurchaseSubtotal: 5,
    });
    expect(body.householdSize).toBe(3);
    expect(JSON.stringify(body)).not.toMatch(/dealMap|synonymMap|ingredientTags|0\.375000000/);
  });

  it("keeps sticker price distinct from pack-aware metric purchase cost", async () => {
    const batch = vi
      .spyOn(api, "searchDealsBatch")
      .mockResolvedValueOnce(new Map([["hakket oksekød", [makeHttpOffer()]]]));
    const body = await (await request({ recipeNames: ["Chili", "Unknown"], people: 6 })).json();
    expect(body).toMatchObject({
      requestedRecipeNames: ["Chili", "Unknown"],
      unknownRecipeNames: ["Unknown"],
      householdSize: 6,
    });
    expect(body.items[0]).toMatchObject({
      selectedOffer: { price: 40, storeId: "n1" },
      purchase: {
        quantityNeeded: 750,
        packSize: 500,
        packsNeeded: 2,
        totalCost: 80,
        leftover: 250,
      },
      matchedPurchaseSubtotal: 80,
    });
    expect(body.storeGroups).toEqual([{ storeName: "Netto", items: body.items }]);
    expect(body.priceSummary.matchedPurchaseSubtotal).toBe(80);
    expect(body).not.toHaveProperty("grandTotal");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("scales semantic units without inventing compatible retail packs", async () => {
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({
            ingredients: [
              { name: "Hvidløg", quantity: "2 fed", searchTerms: ["hvidløg"], category: "produce" },
            ],
          }),
        ],
      }),
    );
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(
      new Map([
        ["hvidløg", [makeHttpOffer({ heading: "Hvidløg", quantity: 1, unit: "stk", price: 10 })]],
      ]),
    );
    const body = await (await request({ recipeNames: ["Chili"] })).json();
    expect(body.items[0]).toMatchObject({
      quantity: { displayQuantity: "1.5 fed", aggregated: { totalAmount: 1.5, unit: "fed" } },
      purchase: null,
      matchedPurchaseSubtotal: 10,
    });
  });

  it("preserves mixed-unit contributions without fabricating an aggregate", async () => {
    const garlic = (quantity: string) => ({
      name: "Hvidløg",
      quantity,
      searchTerms: ["hvidløg"],
      category: "produce",
    });
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({ name: "A", ingredients: [garlic("2 fed")] }),
          makeHttpRecipe({ name: "B", ingredients: [garlic("1 stk")] }),
        ],
      }),
    );
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(new Map());
    const body = await (await request({ recipeNames: ["A", "B"] })).json();
    expect(body.items[0]).toMatchObject({
      quantity: {
        aggregated: null,
        contributions: [
          { scaledAmount: 1.5, scaledUnit: "fed" },
          { scaledAmount: 0.75, scaledUnit: "stk" },
        ],
      },
      purchase: null,
      matchedPurchaseSubtotal: null,
    });
  });

  it("separates confirmed, uncertain and unmatched items and prices", async () => {
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({
            ingredients: [
              ...makeHttpRecipe().ingredients,
              { name: "Mælk", quantity: "5 dl", searchTerms: ["mælk"], category: "dairy" },
              { name: "Unknown", quantity: "1 stk", searchTerms: ["unknown"], category: "other" },
            ],
          }),
        ],
      }),
    );
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(
      new Map([
        ["hakket oksekød", [makeHttpOffer()]],
        [
          "mælk",
          [
            makeHttpOffer({ heading: "Øko mælk eller fløde", quantity: 1, unit: "l", price: 12 }),
            makeHttpOffer({
              id: "milk-alt",
              heading: "Sød mælk eller kærnemælk",
              quantity: 1,
              unit: "l",
              price: 14,
            }),
          ],
        ],
      ]),
    );
    const body = await (await request({ recipeNames: ["Chili"] })).json();
    expect(body.matchSummary).toMatchObject({
      confirmedMatchCount: 1,
      lowConfidenceMatchCount: 1,
      unmatchedItemCount: 1,
    });
    expect(body.priceSummary).toMatchObject({
      confirmedPurchaseSubtotal: 40,
      uncertainPurchaseSubtotal: 12,
      matchedPurchaseSubtotal: 52,
    });
    expect(body.unmatchedItems[0]).toMatchObject({
      selectedOffer: null,
      purchase: null,
      matchedPurchaseSubtotal: null,
    });
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ type: "uncertain-match", ingredientName: "Mælk" }),
    );
  });

  it("preserves the service's expiry snapshot even when serialization happens later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
      vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(
        new Map([["hakket oksekød", [makeHttpOffer({ validUntil: "2026-09-08T00:00:00Z" })]]]),
      );
      const result = await generateShoppingList({ recipeNames: ["Chili"] });
      if (result.status === "no-matching-recipes") throw new Error("Unexpected fixture failure");
      vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
      const dto = shoppingDto(result);
      expect(dto.items[0]).toMatchObject({ expiryStatus: "expires-today", expiryDaysRemaining: 1 });
      expect(dto.warnings).toContainEqual(
        expect.objectContaining({
          type: "expiring-deal",
          expiryStatus: "expires-today",
          daysRemaining: 1,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 422 and resolution context for unknown recipes without fetching deals", async () => {
    const batch = vi.spyOn(api, "searchDealsBatch");
    const res = await request({ recipeNames: ["Nope"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: "NO_MATCHING_RECIPES" },
      result: { unknownRecipeNames: ["Nope"], availableRecipeNames: ["Chili"] },
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("respects pantry defaults and the explicit exclusion override", async () => {
    await store.save(makeHttpStore({ pantry: ["Hakket oksekød"] }));
    const batch = vi.spyOn(api, "searchDealsBatch").mockResolvedValue(new Map());
    const empty = await (await request({ recipeNames: ["Chili"] })).json();
    expect(empty).toMatchObject({
      status: "nothing-to-buy",
      skippedPantryIngredients: ["Hakket oksekød"],
      items: [],
    });
    expect(empty).not.toHaveProperty("grandTotal");
    expect(empty.priceSummary.matchedPurchaseSubtotal).toBe(0);
    expect(batch).not.toHaveBeenCalled();
    const included = await (await request({ recipeNames: ["Chili"], excludePantry: false })).json();
    expect(included.items).toHaveLength(1);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("maps invalid input and unexpected upstream failure", async () => {
    expect((await request({ recipeNames: "Chili" })).status).toBe(400);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(api, "searchDealsBatch").mockRejectedValueOnce(new Error("upstream failure"));
    expect((await request({ recipeNames: ["Chili"] })).status).toBe(500);
  });
});
