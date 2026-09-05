import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Offer } from "../api.js";
import { getLocale } from "../locales.js";
import type { Household, Recipe } from "../store.js";

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, searchDealsBatch: vi.fn() };
});

vi.mock("../store.js", () => ({
  getRecipes: vi.fn(),
  getHousehold: vi.fn(),
  getPantry: vi.fn(),
}));

const api = await import("../api.js");
const store = await import("../store.js");
const { scoreRecipeLibrary, scoreRecipes } = await import("./scoring-service.js");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "beef-offer",
    heading: "Hakket oksekød 8-12%",
    description: null,
    price: 45,
    prePrice: null,
    currency: "DKK",
    quantity: 500,
    unit: "g",
    pricePerUnit: "90.00 kr/kg",
    store: "Netto",
    storeId: "9ba51",
    validFrom: "2026-06-10",
    validUntil: "2026-06-30T00:00:00Z",
    imageUrl: null,
    ...overrides,
  };
}

function ingredient(
  name: string,
  quantity: string,
  searchTerms: string[],
  category = "other",
): Recipe["ingredients"][number] {
  return { name, quantity, searchTerms, category };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "Bolognese",
    servings: 4,
    complexity: "medium",
    cuisineType: "italian",
    proteinType: "beef",
    ingredients: [ingredient("Hakket oksekød", "500 g", ["hakket oksekød"], "meat")],
    ...overrides,
  };
}

function makeHousehold(overrides: Partial<Household> = {}): Household {
  return {
    people: [],
    stores: [],
    defaultServings: 2,
    country: "DK",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(store.getRecipes).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
});

describe("scoreRecipeLibrary", () => {
  it("returns a high-confidence structured recipe and the exact reusable deal map", async () => {
    const offer = makeOffer();
    const dealMap = new Map([["hakket oksekød", [offer]]]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(dealMap);

    const result = await scoreRecipeLibrary({
      recipes: [makeRecipe()],
      preferredStores: new Set(),
      pantrySet: new Set(),
      householdSize: 2,
      locale: getLocale("DK"),
    });

    expect(result.dealMap).toBe(dealMap);
    expect(result.scored).toHaveLength(1);
    expect(result.scored[0]).toMatchObject({
      name: "Bolognese",
      estimatedCost: 22.5,
      dealCoverage: 100,
      matchSummary: {
        eligibleItemCount: 1,
        confirmedMatchCount: 1,
        lowConfidenceMatchCount: 0,
        unmatchedItemCount: 0,
        confirmedCoveragePercent: 100,
        candidateCoveragePercent: 100,
      },
      priceSummary: {
        confirmedDealEstimate: 22.5,
        uncertainDealEstimate: 0,
        matchedDealEstimate: 22.5,
        currency: "DKK",
      },
      ingredients: [
        {
          confidence: "high",
          estimatedCost: 22.5,
          bestDeal: { heading: offer.heading, price: 22.5, store: offer.store },
        },
      ],
    });
    expect(store.getRecipes).not.toHaveBeenCalled();
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);
  });

  it("reports high, low, and unmatched values without changing legacy totals", async () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient("Hakket oksekød", "500 g", ["hakket oksekød"], "meat"),
        ingredient("Mælk", "5 dl", ["mælk"]),
        ingredient("Enhjørning", "1 stk", ["enhjørning"]),
      ],
    });
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hakket oksekød", [makeOffer()]],
        [
          "mælk",
          [
            makeOffer({
              id: "milk",
              heading: "Øko mælk eller fløde",
              price: 12,
              quantity: 1,
              unit: "l",
            }),
          ],
        ],
      ]),
    );

    const { scored } = await scoreRecipeLibrary({
      recipes: [recipe],
      preferredStores: new Set(),
      pantrySet: new Set(),
      householdSize: 2,
      locale: getLocale("DK"),
    });

    expect(scored[0].ingredients.map((item) => item.confidence)).toEqual(["high", "low", "none"]);
    expect(scored[0]).toMatchObject({
      estimatedCost: 25.5,
      dealCoverage: 67,
      matchSummary: {
        confirmedMatchCount: 1,
        lowConfidenceMatchCount: 1,
        unmatchedItemCount: 1,
        confirmedCoveragePercent: 33,
        candidateCoveragePercent: 67,
      },
      priceSummary: {
        confirmedDealEstimate: 22.5,
        uncertainDealEstimate: 3,
        matchedDealEstimate: 25.5,
      },
    });
  });

  it("preserves legacy ranking by coverage and then estimated cost", async () => {
    const recipes = [
      makeRecipe({
        name: "Unmatched",
        ingredients: [ingredient("Enhjørning", "1 stk", ["enhjørning"])],
      }),
      makeRecipe({ name: "Expensive", ingredients: [ingredient("Mælk", "1 l", ["mælk"])] }),
      makeRecipe({ name: "Cheap" }),
    ];
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hakket oksekød", [makeOffer()]],
        ["mælk", [makeOffer({ id: "milk", heading: "Mælk", price: 60, quantity: 1, unit: "l" })]],
      ]),
    );

    const { scored } = await scoreRecipeLibrary({
      recipes,
      preferredStores: new Set(),
      pantrySet: new Set(),
      householdSize: 2,
      locale: getLocale("DK"),
    });

    expect(scored.map((recipe) => recipe.name)).toEqual(["Cheap", "Expensive", "Unmatched"]);
  });

  it("excludes pantry ingredients from retrieval and summary denominators", async () => {
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [makeOffer()]]]));
    const recipe = makeRecipe({
      ingredients: [
        ingredient("Salt", "1 tsk", ["salt"], "pantry"),
        ingredient("Hakket oksekød", "500 g", ["hakket oksekød"], "meat"),
      ],
    });

    const { scored } = await scoreRecipeLibrary({
      recipes: [recipe],
      preferredStores: new Set(),
      pantrySet: new Set(["salt"]),
      householdSize: 2,
      locale: getLocale("DK"),
    });

    expect(vi.mocked(api.searchDealsBatch).mock.calls[0][0]).toEqual(["hakket oksekød"]);
    expect(scored[0].ingredients.map((item) => item.name)).toEqual(["Hakket oksekød"]);
    expect(scored[0].matchSummary.eligibleItemCount).toBe(1);
    expect(scored[0].dealCoverage).toBe(100);
  });

  it("preserves fractional count costing and semantic-unit sticker fallback", async () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient("Citron", "0.5 stk", ["citron"], "produce"),
        ingredient("Hvidløg", "2 fed", ["hvidløg"], "produce"),
      ],
    });
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "citron",
          [makeOffer({ id: "lemon", heading: "Citron", price: 10, quantity: 1, unit: "stk" })],
        ],
        [
          "hvidløg",
          [makeOffer({ id: "garlic", heading: "Hvidløg", price: 8, quantity: 1, unit: "stk" })],
        ],
      ]),
    );

    const { scored } = await scoreRecipeLibrary({
      recipes: [recipe],
      preferredStores: new Set(),
      pantrySet: new Set(),
      householdSize: 3,
      locale: getLocale("DK"),
    });

    expect(scored[0].ingredients).toMatchObject([
      { name: "Citron", quantity: "0.5 stk", estimatedCost: 3.75 },
      { name: "Hvidløg", quantity: "2 fed", estimatedCost: 6 },
    ]);
    expect(scored[0].estimatedCost).toBe(9.75);
  });

  it("returns the existing empty deal map without refetching or special-casing it", async () => {
    const emptyDealMap = new Map<string, Offer[]>();
    vi.mocked(api.searchDealsBatch).mockResolvedValue(emptyDealMap);

    const result = await scoreRecipeLibrary({
      recipes: [makeRecipe()],
      preferredStores: new Set(),
      pantrySet: new Set(),
      householdSize: 2,
      locale: getLocale("DK"),
    });

    expect(result.dealMap).toBe(emptyDealMap);
    expect(result.dealMap.size).toBe(0);
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);
    expect(result.scored[0].ingredients[0].confidence).toBe("none");
  });
});

describe("scoreRecipes", () => {
  it("loads household, pantry, and recipes in the legacy order and returns runtime context", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        people: [
          { name: "Helle", dietaryRestrictions: [], defaultSchedule: {} },
          { name: "Romeo", dietaryRestrictions: [], defaultSchedule: {} },
          { name: "Julie", dietaryRestrictions: [], defaultSchedule: {} },
        ],
      }),
    );
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe()]);

    const result = await scoreRecipes();

    const householdOrder = vi.mocked(store.getHousehold).mock.invocationCallOrder[0];
    const pantryOrder = vi.mocked(store.getPantry).mock.invocationCallOrder[0];
    const recipesOrder = vi.mocked(store.getRecipes).mock.invocationCallOrder[0];
    expect(householdOrder).toBeLessThan(pantryOrder);
    expect(pantryOrder).toBeLessThan(recipesOrder);
    expect(result).toMatchObject({
      householdSize: 3,
      country: "DK",
      currency: "DKK",
      pantry: ["Salt"],
      locale: { country: "DK", currency: "DKK" },
    });
  });

  it("propagates external deal errors unchanged", async () => {
    const expected = new Error("upstream 500");
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe()]);
    vi.mocked(api.searchDealsBatch).mockRejectedValue(expected);

    await expect(scoreRecipes()).rejects.toBe(expected);
  });

  it("propagates datastore errors unchanged before later reads", async () => {
    const expected = new Error("datastore unavailable");
    vi.mocked(store.getHousehold).mockRejectedValue(expected);

    await expect(scoreRecipes()).rejects.toBe(expected);
    expect(store.getPantry).not.toHaveBeenCalled();
    expect(store.getRecipes).not.toHaveBeenCalled();
  });
});
