import { describe, expect, it } from "vitest";
import type { Offer } from "./api.js";
import { getLocale } from "./locales.js";
import {
  aggregateQuantities,
  buildMatchContext,
  calculateBasketCost,
  computeIngredientCost,
  computeShoppingCost,
  computeShoppingCostFromTotal,
  findBestDeal,
  findOptimalWeek,
  formatQuantity,
  isModifierPosition,
  normalizeQuantity,
  parseQuantity,
  SCORE,
  type ScoredRecipe,
  scoreDealMatchCtx,
  summarizeDealMatches,
  summarizeRecipePrices,
  summarizeShoppingPrices,
} from "./scoring.js";
import type { Ingredient } from "./store.js";

// --- Test helpers ---

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "test-1",
    heading: "Hakket oksekød 7-10%",
    description: null,
    price: 45,
    prePrice: null,
    currency: "DKK",
    quantity: 400,
    unit: "g",
    pricePerUnit: "112.50 kr/kg",
    store: "Netto",
    storeId: "9ba51",
    validFrom: "2026-03-25",
    validUntil: "2026-04-03",
    imageUrl: null,
    ...overrides,
  };
}

function makeIngredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    name: "oksekød",
    quantity: "500g",
    searchTerms: ["hakket oksekød", "oksekød"],
    category: "meat",
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<ScoredRecipe> = {}): ScoredRecipe {
  return {
    name: "Bolognese",
    servings: 4,
    complexity: "medium",
    proteinType: "beef",
    cuisineType: "italian",
    estimatedCost: 100,
    dealCoverage: 80,
    ingredients: [],
    ...overrides,
  };
}

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

// --- Confidence-aware summaries ---

describe("confidence-aware summaries", () => {
  it.each([
    {
      name: "only high confidence",
      items: [{ confidence: "high" as const, amount: 12 }],
      match: {
        eligibleItemCount: 1,
        confirmedMatchCount: 1,
        lowConfidenceMatchCount: 0,
        unmatchedItemCount: 0,
        confirmedCoveragePercent: 100,
        candidateCoveragePercent: 100,
      },
      recipePrices: [12, 0, 12],
    },
    {
      name: "high and low confidence",
      items: [
        { confidence: "high" as const, amount: 12 },
        { confidence: "low" as const, amount: 8 },
      ],
      match: {
        eligibleItemCount: 2,
        confirmedMatchCount: 1,
        lowConfidenceMatchCount: 1,
        unmatchedItemCount: 0,
        confirmedCoveragePercent: 50,
        candidateCoveragePercent: 100,
      },
      recipePrices: [12, 8, 20],
    },
    {
      name: "only low confidence",
      items: [{ confidence: "low" as const, amount: 8 }],
      match: {
        eligibleItemCount: 1,
        confirmedMatchCount: 0,
        lowConfidenceMatchCount: 1,
        unmatchedItemCount: 0,
        confirmedCoveragePercent: 0,
        candidateCoveragePercent: 100,
      },
      recipePrices: [0, 8, 8],
    },
    {
      name: "only unmatched",
      items: [{ confidence: "none" as const, amount: 0 }],
      match: {
        eligibleItemCount: 1,
        confirmedMatchCount: 0,
        lowConfidenceMatchCount: 0,
        unmatchedItemCount: 1,
        confirmedCoveragePercent: 0,
        candidateCoveragePercent: 0,
      },
      recipePrices: [0, 0, 0],
    },
    {
      name: "high, low, and unmatched",
      items: [
        { confidence: "high" as const, amount: 12.25 },
        { confidence: "low" as const, amount: 8.5 },
        { confidence: "none" as const, amount: 0 },
      ],
      match: {
        eligibleItemCount: 3,
        confirmedMatchCount: 1,
        lowConfidenceMatchCount: 1,
        unmatchedItemCount: 1,
        confirmedCoveragePercent: 33,
        candidateCoveragePercent: 67,
      },
      recipePrices: [12.25, 8.5, 20.75],
    },
  ])("summarizes $name", ({ items, match, recipePrices }) => {
    expect(summarizeDealMatches(items)).toEqual(match);
    expect(summarizeRecipePrices(items, "DKK")).toEqual({
      confirmedDealEstimate: recipePrices[0],
      uncertainDealEstimate: recipePrices[1],
      matchedDealEstimate: recipePrices[2],
      currency: "DKK",
    });
  });

  it("preserves 100 percent coverage when there are no eligible items", () => {
    expect(summarizeDealMatches([])).toEqual({
      eligibleItemCount: 0,
      confirmedMatchCount: 0,
      lowConfidenceMatchCount: 0,
      unmatchedItemCount: 0,
      confirmedCoveragePercent: 100,
      candidateCoveragePercent: 100,
    });
  });

  it("keeps recipe estimates and shopping purchase subtotals as distinct types", () => {
    const items = [
      { confidence: "high" as const, amount: 45 },
      { confidence: "low" as const, amount: 12 },
      { confidence: "none" as const, amount: 0 },
    ];

    expect(summarizeShoppingPrices(items, "DKK")).toEqual({
      confirmedPurchaseSubtotal: 45,
      uncertainPurchaseSubtotal: 12,
      matchedPurchaseSubtotal: 57,
      currency: "DKK",
    });
    expect(summarizeRecipePrices(items, "DKK")).toEqual({
      confirmedDealEstimate: 45,
      uncertainDealEstimate: 12,
      matchedDealEstimate: 57,
      currency: "DKK",
    });
  });

  it("assigns a repeating-decimal rounding residual without changing the matched total", () => {
    const result = summarizeRecipePrices(
      [
        { confidence: "high", amount: 10 / 3 },
        { confidence: "low", amount: 10 / 3 },
      ],
      "DKK",
    );

    expect(result).toEqual({
      confirmedDealEstimate: 3.33,
      uncertainDealEstimate: 3.34,
      matchedDealEstimate: 6.67,
      currency: "DKK",
    });
    expect(
      toMinorUnits(result.confirmedDealEstimate) + toMinorUnits(result.uncertainDealEstimate),
    ).toBe(toMinorUnits(result.matchedDealEstimate));
  });

  it("preserves original item addition order for the authoritative matched total", () => {
    const result = summarizeRecipePrices(
      [
        { confidence: "high", amount: 39.91 },
        { confidence: "low", amount: 54.835 },
        { confidence: "high", amount: 63.36 },
      ],
      "DKK",
    );

    expect(result).toEqual({
      confirmedDealEstimate: 103.27,
      uncertainDealEstimate: 54.84,
      matchedDealEstimate: 158.11,
      currency: "DKK",
    });
    expect(
      toMinorUnits(result.confirmedDealEstimate) + toMinorUnits(result.uncertainDealEstimate),
    ).toBe(15_811);
  });
});

// --- parseQuantity ---

describe("parseQuantity", () => {
  it("parses grams", () => {
    expect(parseQuantity("500 g")).toEqual({ amount: 500, unit: "g" });
  });

  it("parses grams without space", () => {
    expect(parseQuantity("500g")).toEqual({ amount: 500, unit: "g" });
  });

  it("parses kilograms and converts to grams", () => {
    expect(parseQuantity("1 kg")).toEqual({ amount: 1000, unit: "g" });
  });

  it("parses deciliters and converts to ml", () => {
    expect(parseQuantity("1 dl")).toEqual({ amount: 100, unit: "ml" });
  });

  it("parses liters and converts to ml", () => {
    expect(parseQuantity("0,5 l")).toEqual({ amount: 500, unit: "ml" });
  });

  it.each([
    ["1 liter", 1000, "ml"],
    ["0.5 liter", 500, "ml"],
    ["1,5 liter", 1500, "ml"],
    ["2spsk", 2, "spsk"],
    ["0.75 tsk", 0.75, "tsk"],
    ["3 fed", 3, "fed"],
    ["3 FED", 3, "fed"],
    ["4 skiver", 4, "skiver"],
    ["2 stængler", 2, "stængler"],
    ["1.5 håndfuld", 1.5, "håndfuld"],
  ])("parses simple culinary quantity %s", (quantity, amount, unit) => {
    expect(parseQuantity(quantity)).toEqual({ amount, unit });
  });

  it("parses stk", () => {
    expect(parseQuantity("2 stk")).toEqual({ amount: 2, unit: "stk" });
  });

  it("parses cl", () => {
    expect(parseQuantity("33 cl")).toEqual({ amount: 330, unit: "ml" });
  });

  it("returns null for unparseable quantities", () => {
    expect(parseQuantity("efter smag")).toBeNull();
  });

  it("returns null for unknown units", () => {
    expect(parseQuantity("1 bundt")).toBeNull();
    expect(parseQuantity("2 knivspids")).toBeNull();
  });

  it.each([
    "2-3 spsk",
    "4-5 fed",
    "3 spsk + 1 tsk",
    "2 spsk (hakket)",
    "ca 1600 g",
  ])("keeps complex quantity %s unparseable", (quantity) => {
    expect(parseQuantity(quantity)).toBeNull();
  });

  it("returns null for zero amount", () => {
    expect(parseQuantity("0 g")).toBeNull();
  });

  it("handles decimal with period", () => {
    expect(parseQuantity("1.5 kg")).toEqual({ amount: 1500, unit: "g" });
  });
});

describe("quantity precision and aggregation", () => {
  it("normalizes floating-point noise without integer rounding", () => {
    expect(normalizeQuantity(0.1 + 0.2)).toBe(0.3);
    expect(normalizeQuantity(0.37500000000000006)).toBe(0.375);
  });

  it.each([
    ["0.5 stk", 3, 0.375],
    ["0.5 stk", 2, 0.25],
    ["0.5 stk", 5, 0.625],
    ["0.5 stk", 6, 0.75],
    ["1 stk", 3, 0.75],
    ["1 stk", 2, 0.5],
    ["1 stk", 5, 1.25],
    ["1 stk", 6, 1.5],
    ["2 stk", 3, 1.5],
    ["2 stk", 2, 1],
    ["2 stk", 5, 2.5],
    ["2 stk", 6, 3],
  ])("scales %s from four servings to %i people as %s stk", (quantity, people, expected) => {
    expect(aggregateQuantities([{ quantity, recipeServings: 4 }], people)).toEqual({
      totalAmount: expected,
      unit: "stk",
    });
  });

  it("sums fractional stk requirements before any purchase rounding", () => {
    expect(
      aggregateQuantities(
        [
          { quantity: "0.5 stk", recipeServings: 4 },
          { quantity: "0.5 stk", recipeServings: 4 },
        ],
        4,
      ),
    ).toEqual({ totalAmount: 1, unit: "stk" });

    expect(
      aggregateQuantities(
        [
          { quantity: "0.5 stk", recipeServings: 4 },
          { quantity: "0.5 stk", recipeServings: 4 },
        ],
        3,
      ),
    ).toEqual({ totalAmount: 0.75, unit: "stk" });
  });

  it("preserves a 1.2 stk aggregate for purchase calculation", () => {
    const aggregated = aggregateQuantities(
      [
        { quantity: "0.6 stk", recipeServings: 4 },
        { quantity: "0.6 stk", recipeServings: 4 },
      ],
      4,
    );

    expect(aggregated).toEqual({ totalAmount: 1.2, unit: "stk" });
    expect(
      computeShoppingCostFromTotal(
        makeOffer({ quantity: 1, unit: "stk" }),
        aggregated?.totalAmount ?? 0,
        "stk",
      )?.packsNeeded,
    ).toBe(2);
  });

  it("does not buy an extra pack due only to floating-point noise", () => {
    const aggregated = aggregateQuantities(
      [
        { quantity: "0.1 stk", recipeServings: 4 },
        { quantity: "0.2 stk", recipeServings: 4 },
      ],
      4,
    );

    expect(aggregated?.totalAmount).toBe(0.3);
    expect(
      computeShoppingCostFromTotal(
        makeOffer({ quantity: 0.3, unit: "stk" }),
        aggregated?.totalAmount ?? 0,
        "stk",
      )?.packsNeeded,
    ).toBe(1);
  });

  it.each([
    ["400 g", 3, 300, "g"],
    ["1 kg", 3, 750, "g"],
    ["200 ml", 3, 150, "ml"],
    ["33 cl", 4, 330, "ml"],
    ["2 dl", 3, 150, "ml"],
    ["1 l", 3, 750, "ml"],
  ])("keeps metric scaling stable for %s", (quantity, people, totalAmount, unit) => {
    expect(aggregateQuantities([{ quantity, recipeServings: 4 }], people)).toEqual({
      totalAmount,
      unit,
    });
  });

  it("aggregates compatible metric units in their base units", () => {
    expect(
      aggregateQuantities(
        [
          { quantity: "500 g", recipeServings: 4 },
          { quantity: "0.5 kg", recipeServings: 4 },
        ],
        4,
      ),
    ).toEqual({ totalAmount: 1000, unit: "g" });
    expect(
      aggregateQuantities(
        [
          { quantity: "100 ml", recipeServings: 4 },
          { quantity: "1 dl", recipeServings: 4 },
        ],
        4,
      ),
    ).toEqual({ totalAmount: 200, unit: "ml" });
  });

  it("treats liter as a metric alias during aggregation and display", () => {
    const aggregated = aggregateQuantities(
      [
        { quantity: "1 liter", recipeServings: 4 },
        { quantity: "5 dl", recipeServings: 4 },
      ],
      4,
    );

    expect(aggregated).toEqual({ totalAmount: 1500, unit: "ml" });
    expect(formatQuantity(aggregated?.totalAmount ?? 0, aggregated?.unit ?? "ml")).toBe("1.5 L");
  });

  it.each([
    ["2 fed", 3, 1.5, "fed"],
    ["1 spsk", 2, 0.5, "spsk"],
    ["0.5 håndfuld", 3, 0.375, "håndfuld"],
  ])("scales semantic quantity %s from four servings to %i people", (quantity, people, totalAmount, unit) => {
    expect(aggregateQuantities([{ quantity, recipeServings: 4 }], people)).toEqual({
      totalAmount,
      unit,
    });
  });

  it.each([
    ["2 fed", "1 fed", 3, "fed"],
    ["2 skiver", "4 skiver", 6, "skiver"],
  ])("aggregates matching semantic units %s and %s", (first, second, totalAmount, unit) => {
    expect(
      aggregateQuantities(
        [
          { quantity: first, recipeServings: 4 },
          { quantity: second, recipeServings: 4 },
        ],
        4,
      ),
    ).toEqual({ totalAmount, unit });
  });

  it.each([
    ["2 fed", "100 g"],
    ["1 spsk", "3 tsk"],
  ])("does not aggregate incompatible units %s and %s", (first, second) => {
    expect(
      aggregateQuantities(
        [
          { quantity: first, recipeServings: 4 },
          { quantity: second, recipeServings: 4 },
        ],
        4,
      ),
    ).toBeNull();
  });

  it("formats fractional requirements without noise or trailing zeroes", () => {
    expect(formatQuantity(0.37500000000000006, "stk")).toBe("0.375 stk");
    expect(formatQuantity(0.25, "stk")).toBe("0.25 stk");
    expect(formatQuantity(1.5, "stk")).toBe("1.5 stk");
    expect(formatQuantity(500, "g")).toBe("500 g");
    expect(formatQuantity(1500, "g")).toBe("1.5 kg");
  });
});

// --- computeIngredientCost ---

describe("computeIngredientCost", () => {
  it("computes cost based on unit price and recipe quantity", () => {
    // Offer: 400g for 45 DKK = 112.5 kr/kg. Recipe needs 500g for 4 servings, household of 4.
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const cost = computeIngredientCost(offer, "500 g", 4, 4);
    // 45/400 * 500 * (4/4) = 56.25
    expect(cost).toBeCloseTo(56.25, 2);
  });

  it("scales by household size vs recipe servings", () => {
    // Same offer, but household of 2 eating a recipe for 4
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const cost = computeIngredientCost(offer, "500 g", 4, 2);
    // 45/400 * 500 * (2/4) = 28.125
    expect(cost).toBeCloseTo(28.13, 2);
  });

  it("handles kg recipe vs g offer", () => {
    // Offer: 400g for 45 DKK. Recipe: 1 kg. Household matches servings.
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const cost = computeIngredientCost(offer, "1 kg", 4, 4);
    // 45/400 * 1000 * 1 = 112.5
    expect(cost).toBeCloseTo(112.5, 2);
  });

  it("handles dl recipe vs ml offer", () => {
    // Offer: 1000ml for 20 DKK. Recipe: 2 dl (200ml).
    const offer = makeOffer({ price: 20, quantity: 1000, unit: "ml" });
    const cost = computeIngredientCost(offer, "2 dl", 4, 4);
    // 20/1000 * 200 * 1 = 4
    expect(cost).toBeCloseTo(4, 2);
  });

  it("falls back to sticker price * scale for a pack-incompatible semantic unit", () => {
    const offer = makeOffer({ price: 25 });
    const cost = computeIngredientCost(offer, "3 fed", 4, 4);
    // "fed" cannot be compared with the offer's gram pack.
    expect(cost).toBe(25);
  });

  it("falls back to sticker price * scale when offer has no quantity", () => {
    const offer = makeOffer({ price: 30, quantity: null, unit: null });
    const cost = computeIngredientCost(offer, "500 g", 4, 2);
    // 30 * (2/4) = 15
    expect(cost).toBe(15);
  });

  it("falls back when units are incompatible (g vs ml)", () => {
    const offer = makeOffer({ price: 20, quantity: 500, unit: "ml" });
    const cost = computeIngredientCost(offer, "500 g", 4, 4);
    // Incompatible units, falls back to 20 * (4/4) = 20
    expect(cost).toBe(20);
  });

  it("returns 0 for null price", () => {
    const offer = makeOffer({ price: null });
    expect(computeIngredientCost(offer, "500 g", 4, 4)).toBe(0);
  });

  it("returns 0 for zero price", () => {
    const offer = makeOffer({ price: 0 });
    expect(computeIngredientCost(offer, "500 g", 4, 4)).toBe(0);
  });
});

// --- computeShoppingCost ---

describe("computeShoppingCost", () => {
  it("computes 1 pack when quantity fits", () => {
    // Need 375g (500g × 3/4), pack is 400g
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const result = computeShoppingCost(offer, "500 g", 4, 3);
    expect(result).not.toBeNull();
    expect(result?.quantityNeeded).toBe(375);
    expect(result?.packsNeeded).toBe(1);
    expect(result?.totalCost).toBe(45);
    expect(result?.leftover).toBe(25);
  });

  it("computes 2 packs when quantity exceeds 1 pack", () => {
    // Need 625g (500g × 5/4), pack is 400g → need 2
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const result = computeShoppingCost(offer, "500 g", 4, 5);
    expect(result).not.toBeNull();
    expect(result?.packsNeeded).toBe(2);
    expect(result?.totalCost).toBe(90);
    expect(result?.leftover).toBe(175);
  });

  it("handles kg recipe vs g offer", () => {
    // Need 750g (1kg × 3/4), pack is 400g → need 2
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const result = computeShoppingCost(offer, "1 kg", 4, 3);
    expect(result).not.toBeNull();
    expect(result?.quantityNeeded).toBe(750);
    expect(result?.packsNeeded).toBe(2);
    expect(result?.totalCost).toBe(90);
  });

  it("handles dl recipe vs ml offer", () => {
    // Need 150ml (2dl × 3/4), pack is 1000ml → 1 pack
    const offer = makeOffer({ price: 20, quantity: 1000, unit: "ml" });
    const result = computeShoppingCost(offer, "2 dl", 4, 3);
    expect(result).not.toBeNull();
    expect(result?.quantityNeeded).toBe(150);
    expect(result?.packsNeeded).toBe(1);
    expect(result?.totalCost).toBe(20);
    expect(result?.leftover).toBe(850);
  });

  it("returns null for unparseable quantities", () => {
    const offer = makeOffer({ price: 25 });
    expect(computeShoppingCost(offer, "3 fed", 4, 3)).toBeNull();
  });

  it("returns null for incompatible units", () => {
    const offer = makeOffer({ price: 20, quantity: 500, unit: "ml" });
    expect(computeShoppingCost(offer, "500 g", 4, 3)).toBeNull();
  });

  it("keeps semantic recipe units incompatible with offer packs", () => {
    expect(computeShoppingCost(makeOffer({ quantity: 1, unit: "stk" }), "2 fed", 4, 3)).toBeNull();
    expect(
      computeShoppingCost(makeOffer({ quantity: 200, unit: "g" }), "3 skiver", 4, 3),
    ).toBeNull();
    expect(
      computeShoppingCost(makeOffer({ quantity: 500, unit: "ml" }), "2 spsk", 4, 3),
    ).toBeNull();
    expect(computeShoppingCost(makeOffer({ quantity: 2, unit: "fed" }), "2 fed", 4, 3)).toBeNull();
  });

  it("uses metric pack calculation for the liter alias", () => {
    const result = computeShoppingCost(
      makeOffer({ price: 10, quantity: 500, unit: "ml" }),
      "1 liter",
      4,
      4,
    );

    expect(result).toMatchObject({
      quantityNeeded: 1000,
      unitNeeded: "ml",
      packSize: 500,
      packsNeeded: 2,
      totalCost: 20,
      leftover: 0,
    });
  });
});

describe("purchase quantity", () => {
  it.each([
    [0.375, 1, 1],
    [1, 1, 1],
    [1.2, 1, 2],
    [2, 2, 1],
  ])("keeps a %s stk requirement separate from %s-stk packs", (requirement, packSize, packsNeeded) => {
    const result = computeShoppingCostFromTotal(
      makeOffer({ quantity: packSize, unit: "stk" }),
      requirement,
      "stk",
    );

    expect(result?.quantityNeeded).toBe(requirement);
    expect(result?.packSize).toBe(packSize);
    expect(result?.packsNeeded).toBe(packsNeeded);
  });
});

// --- scoreDealMatch ---

describe("scoreDealMatch", () => {
  it("returns 0 for null price", () => {
    const offer = makeOffer({ price: null });
    const ing = makeIngredient();
    expect(scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(new Set()))).toBe(0);
  });

  it("returns 0 for zero price", () => {
    const offer = makeOffer({ price: 0 });
    const ing = makeIngredient();
    expect(scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(new Set()))).toBe(0);
  });

  it("returns base score for a basic match with no preferences", () => {
    const offer = makeOffer({ heading: "Hakket oksekød" });
    const ing = makeIngredient({ category: "dairy" }); // non-meat to skip form detection
    const score = scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(new Set()));
    expect(score).toBe(SCORE.BASE + SCORE.PARTIAL_MATCH_BONUS);
  });

  it("gives exact match bonus when heading starts with search term", () => {
    const offer = makeOffer({ heading: "oksekød 7-10%" });
    const ing = makeIngredient({ category: "dairy" });
    const score = scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(new Set()));
    expect(score).toBe(SCORE.BASE + SCORE.EXACT_MATCH_BONUS);
  });

  it("gives preferred store bonus", () => {
    const offer = makeOffer({ store: "Netto" });
    const ing = makeIngredient({ category: "dairy" });
    const preferred = new Set(["Netto"]);
    const score = scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(preferred));
    expect(score).toBeGreaterThan(SCORE.BASE);
  });

  it("uses matching dealer IDs as the authoritative preferred-store identity", () => {
    const offer = makeOffer({ store: "Føtex", storeId: "bdf5A" });
    const preferred = [{ name: "foetex", dealerId: "bdf5A" }];
    const score = scoreDealMatchCtx(
      offer,
      makeIngredient({ category: "dairy" }),
      "oksekød",
      buildMatchContext(preferred, getLocale("DK")),
    );
    expect(score).toBeGreaterThan(SCORE.BASE);
  });

  it("rejects a matching display name when the stable dealer ID is wrong", () => {
    const offer = makeOffer({ store: "Føtex", storeId: "wrong-id" });
    const preferred = [{ name: "Føtex", dealerId: "bdf5A" }];
    const score = scoreDealMatchCtx(
      offer,
      makeIngredient({ category: "dairy" }),
      "oksekød",
      buildMatchContext(preferred, getLocale("DK")),
    );
    expect(score).toBe(0);
  });

  it("uses locale store aliases only as a fallback when a stable ID is missing", () => {
    const offer = makeOffer({ store: "Føtex", storeId: "" });
    const preferred = [{ name: "foetex" }];
    const score = scoreDealMatchCtx(
      offer,
      makeIngredient({ category: "dairy" }),
      "oksekød",
      buildMatchContext(preferred, getLocale("DK")),
    );
    expect(score).toBeGreaterThan(SCORE.BASE);
  });

  it("penalizes non-preferred stores", () => {
    const offer = makeOffer({ store: "Bilka" });
    const ing = makeIngredient({ category: "dairy" });
    const preferred = new Set(["Netto"]);
    const score = scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(preferred));
    expect(score).toBeLessThan(SCORE.BASE);
  });

  it("penalizes processed meat products", () => {
    const offer = makeOffer({ heading: "Røget laks" });
    const ing = makeIngredient({ category: "meat" });
    const score = scoreDealMatchCtx(offer, ing, "laks", buildMatchContext(new Set()));
    expect(score).toBeLessThan(SCORE.BASE);
  });

  it("bonuses raw meat indicators", () => {
    const offer = makeOffer({ heading: "Fersk hakket oksekød" });
    const ing = makeIngredient({ category: "meat" });
    const score = scoreDealMatchCtx(offer, ing, "oksekød", buildMatchContext(new Set()));
    expect(score).toBeGreaterThan(SCORE.BASE);
  });

  it("penalizes bundle uncertainty for processed bundles", () => {
    const offer = makeOffer({ heading: "Rejer, kold- eller varmrøget laks" });
    const ing = makeIngredient({ category: "meat" });
    const score = scoreDealMatchCtx(offer, ing, "laks", buildMatchContext(new Set()));
    expect(score).toBeLessThan(SCORE.VIABILITY_THRESHOLD);
  });

  it("does not apply meat processing rules to non-meat categories", () => {
    const offer = makeOffer({ heading: "Røget ost" });
    const ing = makeIngredient({ category: "dairy" });
    const score = scoreDealMatchCtx(offer, ing, "ost", buildMatchContext(new Set()));
    // Should get base + partial match, no processing penalty
    expect(score).toBe(SCORE.BASE + SCORE.PARTIAL_MATCH_BONUS);
  });

  it("penalizes modifier position (term after preposition)", () => {
    const offer = makeOffer({ heading: "Tunfilet i olivenolie" });
    const ing = makeIngredient({ category: "pantry" });
    const score = scoreDealMatchCtx(offer, ing, "olivenolie", buildMatchContext(new Set()));
    // Should get modifier penalty, well below confident threshold
    expect(score).toBeLessThan(SCORE.CONFIDENT_THRESHOLD);
  });

  it("does not penalize when term is the primary product", () => {
    const offer = makeOffer({ heading: "Olivenolie extra virgin" });
    const ing = makeIngredient({ category: "pantry" });
    const score = scoreDealMatchCtx(offer, ing, "olivenolie", buildMatchContext(new Set()));
    expect(score).toBe(SCORE.BASE + SCORE.EXACT_MATCH_BONUS);
  });

  it("penalizes when term not found at all in heading", () => {
    const offer = makeOffer({ heading: "Vaseline lotion" });
    const ing = makeIngredient({ category: "pantry" });
    const score = scoreDealMatchCtx(offer, ing, "MSG", buildMatchContext(new Set()));
    expect(score).toBe(0);
  });
});

// --- isModifierPosition ---

describe("isModifierPosition", () => {
  it("detects term after 'i'", () => {
    expect(isModifierPosition("tunfilet i olivenolie", "olivenolie")).toBe(true);
  });

  it("detects term after 'med'", () => {
    expect(isModifierPosition("pizza med hvidløg", "hvidløg")).toBe(true);
  });

  it("detects term after 'og'", () => {
    expect(isModifierPosition("ost og skinke", "skinke")).toBe(true);
  });

  it("returns false when term starts the heading", () => {
    expect(isModifierPosition("olivenolie extra virgin", "olivenolie")).toBe(false);
  });

  it("returns false when term is not after a preposition", () => {
    expect(isModifierPosition("hakket oksekød 7-10%", "oksekød")).toBe(false);
  });

  it("returns false when term not found", () => {
    expect(isModifierPosition("hakket oksekød", "laks")).toBe(false);
  });
});

// --- findBestDeal ---

describe("findBestDeal", () => {
  it("returns confidence none when no deals match", () => {
    const ing = makeIngredient();
    const dealMap = new Map<string, Offer[]>();
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.best).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.candidates).toHaveLength(0);
  });

  it("returns the best-scoring offer", () => {
    const rawOffer = makeOffer({ heading: "Fersk hakket oksekød", price: 50 });
    const processedOffer = makeOffer({
      heading: "Røget oksekød pålæg",
      price: 30,
    });
    const ing = makeIngredient({ searchTerms: ["oksekød"] });
    const dealMap = new Map([["oksekød", [rawOffer, processedOffer]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.best).toBe(rawOffer);
  });

  it("picks cheaper offer when scores tie", () => {
    const cheap = makeOffer({
      id: "cheap",
      heading: "Hakket oksekød",
      price: 30,
    });
    const expensive = makeOffer({
      id: "expensive",
      heading: "Hakket oksekød",
      price: 60,
    });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "dairy" });
    const dealMap = new Map([["oksekød", [expensive, cheap]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.best).toBe(cheap);
  });

  it("searches across multiple search terms", () => {
    const offer = makeOffer({ heading: "Dansk lammekølle", price: 55 });
    const ing = makeIngredient({
      name: "lam",
      searchTerms: ["lammekølle", "lam"],
      category: "meat",
    });
    const dealMap = new Map<string, Offer[]>([
      ["lammekølle", [offer]],
      ["lam", []],
    ]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.best).toBe(offer);
  });

  it("returns high confidence for strong matches", () => {
    const offer = makeOffer({
      heading: "Hakket oksekød 7-10%",
      price: 45,
      store: "Netto",
    });
    const ing = makeIngredient({ searchTerms: ["hakket oksekød"] });
    const preferred = new Set(["Netto"]);
    const dealMap = new Map([["hakket oksekød", [offer]]]);
    const result = findBestDeal(ing, dealMap, preferred);
    expect(result.confidence).toBe("high");
  });

  it("returns low confidence for modifier matches", () => {
    const offer = makeOffer({ heading: "Tunfilet i olivenolie", price: 20 });
    const ing = makeIngredient({
      name: "olivenolie",
      searchTerms: ["olivenolie"],
      category: "pantry",
    });
    const dealMap = new Map([["olivenolie", [offer]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    // Modifier match should be low confidence (if it passes viability at all)
    if (result.best) {
      expect(result.confidence).toBe("low");
    } else {
      expect(result.confidence).toBe("none");
    }
  });

  it("does not promote Tuborg Squash to a high-confidence squash match", () => {
    const offer = makeOffer({
      heading: "Coca-Cola, Fanta eller Tuborg Squash",
      store: "365discount",
      storeId: "DWZE1w",
    });
    const ingredient = makeIngredient({
      name: "Squash",
      searchTerms: ["squash"],
      category: "produce",
    });
    const result = findBestDeal(
      ingredient,
      new Map([["squash", [offer]]]),
      [{ name: "365discount", dealerId: "DWZE1w" }],
      getLocale("DK"),
    );

    expect(result.best).toBe(offer);
    expect(result.confidence).toBe("low");
    expect(result.bestScore).toBeLessThan(SCORE.CONFIDENT_THRESHOLD);
  });

  it("returns up to 3 candidates", () => {
    const offer1 = makeOffer({ id: "a", heading: "Hakket oksekød", price: 45 });
    const offer2 = makeOffer({
      id: "b",
      heading: "Oksekød i strimler",
      price: 55,
    });
    const offer3 = makeOffer({ id: "c", heading: "Fersk oksekød", price: 50 });
    const offer4 = makeOffer({ id: "d", heading: "Dansk oksekød", price: 60 });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "dairy" });
    const dealMap = new Map([["oksekød", [offer1, offer2, offer3, offer4]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });
});

// --- calculateBasketCost ---

describe("calculateBasketCost", () => {
  it("returns zero for empty recipe list", () => {
    const result = calculateBasketCost([]);
    expect(result.totalCost).toBe(0);
    expect(result.uniqueIngredients).toBe(0);
    expect(result.sharedSavings).toBe(0);
  });

  it("sums ingredient prices", () => {
    const recipe = makeRecipe({
      ingredients: [
        {
          name: "oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: { heading: "Oksekød", price: 45, store: "Netto" },
          estimatedCost: 45,
        },
        {
          name: "tomater",
          quantity: "400g",
          category: "produce",
          bestDeal: { heading: "Tomater", price: 15, store: "Netto" },
          estimatedCost: 15,
        },
      ],
    });
    const result = calculateBasketCost([recipe]);
    expect(result.totalCost).toBe(60);
    expect(result.uniqueIngredients).toBe(2);
  });

  it("deduplicates shared ingredients across recipes", () => {
    const recipe1 = makeRecipe({
      name: "Bolognese",
      ingredients: [
        {
          name: "Oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: { heading: "Oksekød", price: 45, store: "Netto" },
          estimatedCost: 45,
        },
      ],
    });
    const recipe2 = makeRecipe({
      name: "Chili con carne",
      proteinType: "beef",
      cuisineType: "mexican",
      ingredients: [
        {
          name: "oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: { heading: "Oksekød", price: 45, store: "Netto" },
          estimatedCost: 45,
        },
      ],
    });
    const result = calculateBasketCost([recipe1, recipe2]);
    expect(result.totalCost).toBe(45); // bought once
    expect(result.sharedSavings).toBe(45); // saved on second recipe
    expect(result.uniqueIngredients).toBe(1);
  });

  it("skips ingredients with no deal", () => {
    const recipe = makeRecipe({
      ingredients: [
        {
          name: "oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: null,
          estimatedCost: 0,
        },
      ],
    });
    const result = calculateBasketCost([recipe]);
    expect(result.totalCost).toBe(0);
  });
});

// --- findOptimalWeek ---

describe("findOptimalWeek", () => {
  const constraints = { maxPerProtein: 2, maxPerCuisine: 2, maxSlowDays: 2 };

  it("returns null for empty recipe list", () => {
    expect(findOptimalWeek([], 3, constraints)).toBeNull();
  });

  it("returns null when not enough recipes for requested days", () => {
    const recipes = [makeRecipe()];
    expect(findOptimalWeek(recipes, 3, constraints)).toBeNull();
  });

  it("picks cheapest recipes that fit constraints", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "asian",
        complexity: "quick",
        estimatedCost: 50,
        ingredients: [],
      }),
      makeRecipe({
        name: "B",
        proteinType: "beef",
        cuisineType: "italian",
        complexity: "medium",
        estimatedCost: 60,
        ingredients: [],
      }),
      makeRecipe({
        name: "C",
        proteinType: "fish",
        cuisineType: "danish",
        complexity: "slow",
        estimatedCost: 70,
        ingredients: [],
      }),
      makeRecipe({
        name: "D",
        proteinType: "pork",
        cuisineType: "mexican",
        complexity: "quick",
        estimatedCost: 80,
        ingredients: [],
      }),
    ];
    const result = findOptimalWeek(recipes, 3, constraints);
    expect(result).not.toBeNull();
    expect(result?.recipes).toHaveLength(3);
    // Should pick the 3 cheapest (A, B, C) since all constraints are satisfied
    expect(result?.recipes.map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("respects protein variety constraint", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "a",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "b",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "chicken",
        cuisineType: "c",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "beef",
        cuisineType: "d",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      maxPerProtein: 2,
    });
    expect(result).not.toBeNull();
    const chickenCount = result?.recipes.filter((r) => r.proteinType === "chicken").length ?? 0;
    expect(chickenCount).toBeLessThanOrEqual(2);
  });

  it("respects cuisine variety constraint", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "a",
        cuisineType: "italian",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "b",
        cuisineType: "italian",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "c",
        cuisineType: "italian",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "d",
        cuisineType: "asian",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      maxPerCuisine: 2,
    });
    expect(result).not.toBeNull();
    const italianCount = result?.recipes.filter((r) => r.cuisineType === "italian").length ?? 0;
    expect(italianCount).toBeLessThanOrEqual(2);
  });

  it("respects slow day constraint", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "a",
        cuisineType: "a",
        complexity: "slow",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "b",
        cuisineType: "b",
        complexity: "slow",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "c",
        cuisineType: "c",
        complexity: "quick",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "d",
        cuisineType: "d",
        complexity: "quick",
        estimatedCost: 40,
      }),
      makeRecipe({
        name: "E",
        proteinType: "e",
        cuisineType: "e",
        complexity: "medium",
        estimatedCost: 50,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      maxSlowDays: 1,
    });
    expect(result).not.toBeNull();
    const slowCount = result?.recipes.filter((r) => r.complexity === "slow").length ?? 0;
    expect(slowCount).toBeLessThanOrEqual(1);
  });

  it("returns null when constraints are impossible to satisfy", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "italian",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "italian",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "chicken",
        cuisineType: "italian",
        estimatedCost: 30,
      }),
    ];
    // Need 3 days but maxPerProtein=1 and all are chicken
    const result = findOptimalWeek(recipes, 3, {
      maxPerProtein: 1,
      maxPerCuisine: 1,
      maxSlowDays: 1,
    });
    expect(result).toBeNull();
  });

  it("excludes proteins globally", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "pork",
        cuisineType: "a",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "b",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "beef",
        cuisineType: "c",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "fish",
        cuisineType: "d",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      excludeProteins: ["pork"],
    });
    expect(result).not.toBeNull();
    expect(result?.recipes.every((r) => r.proteinType !== "pork")).toBe(true);
  });

  it("allows excluded protein on specific days", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "a",
        estimatedCost: 50,
      }),
      makeRecipe({
        name: "B",
        proteinType: "pork",
        cuisineType: "b",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "C",
        proteinType: "beef",
        cuisineType: "c",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "fish",
        cuisineType: "d",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      excludeProteins: ["pork"],
      allowProteinOnDays: { pork: [1] },
    });
    expect(result).not.toBeNull();
    // Pork should be on day 1 (cheapest and allowed there)
    expect(result?.recipes[0].proteinType).toBe("pork");
  });

  it("restricts slow recipes to specific days", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "a",
        cuisineType: "a",
        complexity: "slow",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "b",
        cuisineType: "b",
        complexity: "quick",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "c",
        cuisineType: "c",
        complexity: "quick",
        estimatedCost: 30,
      }),
    ];
    // Slow only allowed on day 3
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      slowOnlyOnDays: [3],
    });
    expect(result).not.toBeNull();
    // Slow recipe "A" should be on day 3 (position index 2)
    const slowIdx = result?.recipes.findIndex((r) => r.complexity === "slow") ?? -1;
    expect(slowIdx).toBe(2);
  });

  it("combines exclude + slow constraints", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "pork",
        cuisineType: "a",
        complexity: "slow",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "b",
        complexity: "quick",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "beef",
        cuisineType: "c",
        complexity: "quick",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "fish",
        cuisineType: "d",
        complexity: "slow",
        estimatedCost: 40,
      }),
      makeRecipe({
        name: "E",
        proteinType: "egg",
        cuisineType: "e",
        complexity: "quick",
        estimatedCost: 50,
      }),
    ];
    // No pork, slow only on day 3
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      excludeProteins: ["pork"],
      slowOnlyOnDays: [3],
    });
    expect(result).not.toBeNull();
    expect(result?.recipes.every((r) => r.proteinType !== "pork")).toBe(true);
    for (let i = 0; i < (result?.recipes.length ?? 0); i++) {
      if (result?.recipes[i].complexity === "slow") {
        expect(i + 1).toBe(3); // slow only on day 3
      }
    }
  });
});
