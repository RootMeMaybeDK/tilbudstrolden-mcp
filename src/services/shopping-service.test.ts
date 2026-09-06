import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { buildShoppingListFromRecipes, generateShoppingList } = await import(
  "./shopping-service.js"
);

const NOW = new Date("2026-06-15T12:00:00Z");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "beef",
    heading: "Hakket oksekød 8-12%",
    description: null,
    price: 45,
    prePrice: null,
    currency: "DKK",
    quantity: 500,
    unit: "g",
    pricePerUnit: "90.00 kr/kg",
    store: "Netto",
    storeId: "n1",
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

function build(
  recipes: Recipe[],
  dealMap: Map<string, Offer[]>,
  overrides: Partial<Parameters<typeof buildShoppingListFromRecipes>[0]> = {},
) {
  return buildShoppingListFromRecipes({
    selectedRecipes: recipes,
    householdSize: 2,
    pantry: [],
    excludePantry: true,
    preferredStores: new Set(),
    locale: getLocale("DK"),
    existingDealMap: dealMap,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(store.getRecipes).mockResolvedValue([]);
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildShoppingListFromRecipes", () => {
  it("returns a high-confidence item with its selected offer, pack cost, and store group", async () => {
    const offer = makeOffer();
    const result = await build([makeRecipe()], new Map([["hakket oksekød", [offer]]]));

    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({
      ingredientName: "Hakket oksekød",
      category: "meat",
      confidence: "high",
      selectedOffer: offer,
      selectedMatchScore: 85,
      matchedPurchaseSubtotal: 45,
      quantity: {
        displayQuantity: "250 g",
        aggregated: { totalAmount: 250, unit: "g" },
      },
      purchase: {
        quantityNeeded: 250,
        unitNeeded: "g",
        packSize: 500,
        packsNeeded: 1,
        pricePerPack: 45,
        totalCost: 45,
        leftover: 250,
      },
    });
    expect(result.items[0].selectedOffer).toBe(offer);
    expect(result.storeGroups).toHaveLength(1);
    expect(result.storeGroups[0].storeName).toBe("Netto");
    expect(result.storeGroups[0].items[0]).toBe(result.items[0]);
  });

  it("represents low-confidence candidates, warning, and uncertain subtotal", async () => {
    const recipe = makeRecipe({
      ingredients: [ingredient("Mælk", "5 dl", ["mælk"])],
    });
    const selected = makeOffer({
      id: "milk-1",
      heading: "Øko mælk eller fløde",
      price: 12,
      quantity: 1,
      unit: "l",
    });
    const alternative = makeOffer({
      id: "milk-2",
      heading: "Sød mælk eller kærnemælk",
      price: 14,
      quantity: 1,
      unit: "l",
    });

    const result = await build([recipe], new Map([["mælk", [selected, alternative]]]));

    expect(result.items[0]).toMatchObject({
      confidence: "low",
      selectedOffer: selected,
      matchedPurchaseSubtotal: 12,
    });
    expect(result.warnings).toEqual([
      {
        type: "uncertain-match",
        ingredientName: "Mælk",
        selectedOffer: selected,
        alternatives: [{ offer: alternative, score: expect.any(Number) }],
      },
    ]);
    expect(result.priceSummary).toMatchObject({
      confirmedPurchaseSubtotal: 0,
      uncertainPurchaseSubtotal: 12,
      matchedPurchaseSubtotal: 12,
    });
  });

  it("uses null rather than a zero price for unmatched items", async () => {
    const recipe = makeRecipe({
      ingredients: [ingredient("Enhjørning", "1 stk", ["enhjørning"])],
    });

    const result = await build([recipe], new Map());

    expect(result.unmatchedItems).toHaveLength(1);
    expect(result.unmatchedItems[0]).toMatchObject({
      confidence: "none",
      selectedOffer: null,
      purchase: null,
      matchedPurchaseSubtotal: null,
      fromRecipes: ["Bolognese"],
    });
    expect(result.matchedItems).toEqual([]);
    expect(result.matchSummary.unmatchedItemCount).toBe(1);
    expect(result.priceSummary.matchedPurchaseSubtotal).toBe(0);
    expect(result.grandTotal).toBe(0);
  });

  it("excludes pantry ingredients and reports the skipped pantry data", async () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient("Salt", "1 tsk", ["salt"], "pantry"),
        ingredient("Hakket oksekød", "500 g", ["hakket oksekød"], "meat"),
      ],
    });
    const result = await build([recipe], new Map([["hakket oksekød", [makeOffer()]]]), {
      pantry: ["Salt"],
    });

    expect(result.items.map((item) => item.ingredientName)).toEqual(["Hakket oksekød"]);
    expect(result.skippedPantryIngredients).toEqual(["Salt"]);
    expect(result.matchSummary.eligibleItemCount).toBe(1);
  });

  it("preserves a 0.375 stk requirement separately from the one-pack purchase", async () => {
    const recipe = makeRecipe({
      ingredients: [ingredient("Citron", "0.5 stk", ["citron"], "produce")],
    });
    const offer = makeOffer({
      id: "lemon",
      heading: "Citron",
      price: 5,
      quantity: 1,
      unit: "stk",
      pricePerUnit: null,
    });

    const result = await build([recipe], new Map([["citron", [offer]]]), {
      householdSize: 3,
    });

    expect(result.items[0].quantity).toMatchObject({
      displayQuantity: "0.375 stk",
      aggregated: { totalAmount: 0.375, unit: "stk" },
      contributions: [
        {
          quantity: "0.5 stk",
          scaledAmount: 0.375,
          scaledUnit: "stk",
          displayQuantity: "0.375 stk",
        },
      ],
    });
    expect(result.items[0].purchase).toMatchObject({
      quantityNeeded: 0.375,
      packsNeeded: 1,
      leftover: 0.625,
    });
  });

  it("keeps semantic-unit fallback and mixed-unit contributions structured", async () => {
    const recipes = [
      makeRecipe({
        name: "Recipe A",
        ingredients: [ingredient("Bacon", "250 g", ["bacon"], "meat")],
      }),
      makeRecipe({
        name: "Recipe B",
        ingredients: [ingredient("Bacon", "3 skiver", ["bacon"], "meat")],
      }),
      makeRecipe({
        name: "Recipe C",
        ingredients: [ingredient("Hvidløg", "2 fed", ["hvidløg"], "produce")],
      }),
    ];
    const bacon = makeOffer({
      id: "bacon",
      heading: "Bacon",
      price: 20,
      quantity: 200,
      unit: "g",
    });
    const garlic = makeOffer({
      id: "garlic",
      heading: "Hvidløg",
      price: 8,
      quantity: 1,
      unit: "stk",
    });

    const result = await build(
      recipes,
      new Map([
        ["bacon", [bacon]],
        ["hvidløg", [garlic]],
      ]),
      { householdSize: 3 },
    );
    const baconItem = result.items.find((item) => item.ingredientName === "Bacon");
    const garlicItem = result.items.find((item) => item.ingredientName === "Hvidløg");

    expect(baconItem?.quantity).toMatchObject({
      displayQuantity: "187.5 g + 2.25 skiver",
      aggregated: null,
      contributions: [
        { scaledAmount: 187.5, scaledUnit: "g", displayQuantity: "187.5 g" },
        { scaledAmount: 2.25, scaledUnit: "skiver", displayQuantity: "2.25 skiver" },
      ],
    });
    expect(baconItem?.purchase).toBeNull();
    expect(baconItem?.matchedPurchaseSubtotal).toBe(20);
    expect(garlicItem?.quantity).toMatchObject({
      displayQuantity: "1.5 fed",
      aggregated: { totalAmount: 1.5, unit: "fed" },
    });
    expect(garlicItem?.purchase).toBeNull();
    expect(garlicItem?.matchedPurchaseSubtotal).toBe(8);
    expect(result.grandTotal).toBe(28);
  });

  it("preserves store insertion order, item order, and unmatched order", async () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient("Mælk", "1 l", ["mælk"]),
        ingredient("Hakket oksekød", "500 g", ["hakket oksekød"], "meat"),
        ingredient("Yoghurt", "1 l", ["yoghurt"]),
        ingredient("Ukendt A", "1 stk", ["ukendt a"]),
        ingredient("Ukendt B", "1 stk", ["ukendt b"]),
      ],
    });
    const deals = new Map<string, Offer[]>([
      [
        "mælk",
        [
          makeOffer({
            id: "milk",
            heading: "Mælk",
            store: "Lidl",
            storeId: "l1",
            unit: "l",
            quantity: 1,
          }),
        ],
      ],
      ["hakket oksekød", [makeOffer()]],
      [
        "yoghurt",
        [
          makeOffer({
            id: "yoghurt",
            heading: "Yoghurt",
            store: "Lidl",
            storeId: "l1",
            unit: "l",
            quantity: 1,
          }),
        ],
      ],
    ]);

    const result = await build([recipe], deals);

    expect(result.storeGroups.map((group) => group.storeName)).toEqual(["Lidl", "Netto"]);
    expect(result.storeGroups[0].items.map((item) => item.ingredientName)).toEqual([
      "Mælk",
      "Yoghurt",
    ]);
    expect(result.unmatchedItems.map((item) => item.ingredientName)).toEqual([
      "Ukendt A",
      "Ukendt B",
    ]);
  });

  it("returns a typed expiry warning tied to the selected offer", async () => {
    const offer = makeOffer({ validUntil: "2026-06-16T00:00:00Z" });
    const result = await build([makeRecipe()], new Map([["hakket oksekød", [offer]]]));

    expect(result.items[0]).toMatchObject({
      expiryStatus: "expires-today",
      expiryDaysRemaining: 1,
    });
    expect(result.warnings).toEqual([
      {
        type: "expiring-deal",
        ingredientName: "Hakket oksekød",
        offer,
        daysRemaining: 1,
        expiryStatus: "expires-today",
      },
    ]);
  });

  it("keeps confirmed, uncertain, matched, and legacy totals aligned", async () => {
    const recipe = makeRecipe({
      ingredients: [
        ingredient("Hakket oksekød", "500 g", ["hakket oksekød"], "meat"),
        ingredient("Mælk", "5 dl", ["mælk"]),
        ingredient("Enhjørning", "1 stk", ["enhjørning"]),
      ],
    });
    const result = await build(
      [recipe],
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

    expect(result.matchSummary).toEqual({
      eligibleItemCount: 3,
      confirmedMatchCount: 1,
      lowConfidenceMatchCount: 1,
      unmatchedItemCount: 1,
      confirmedCoveragePercent: 33,
      candidateCoveragePercent: 67,
    });
    expect(result.priceSummary).toEqual({
      confirmedPurchaseSubtotal: 45,
      uncertainPurchaseSubtotal: 12,
      matchedPurchaseSubtotal: 57,
      currency: "DKK",
    });
    expect(result.grandTotal).toBe(57);
  });

  it("does not refetch when a populated or empty deal map is supplied", async () => {
    await build([makeRecipe()], new Map([["hakket oksekød", [makeOffer()]]]));
    await build([makeRecipe()], new Map());

    expect(api.searchDealsBatch).not.toHaveBeenCalled();
  });

  it("propagates an upstream deal error without wrapping it", async () => {
    const expected = new Error("upstream 500");
    vi.mocked(api.searchDealsBatch).mockRejectedValue(expected);

    const promise = buildShoppingListFromRecipes({
      selectedRecipes: [makeRecipe()],
      householdSize: 2,
      pantry: [],
      excludePantry: true,
      preferredStores: new Set(),
      locale: getLocale("DK"),
    });

    await expect(promise).rejects.toBe(expected);
  });
});

describe("generateShoppingList", () => {
  it("preserves recipe resolution and the recipes → household → pantry → household read order", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      makeRecipe({ name: "Bolognese" }),
      makeRecipe({ name: "Chili" }),
    ]);
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold({ defaultServings: 3 }));

    const result = await generateShoppingList({
      recipeNames: ["chili", "Missing"],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected a shopping result");
    expect(result.selectedRecipes.map((recipe) => recipe.name)).toEqual(["Chili"]);
    expect(result.requestedRecipeNames).toEqual(["chili", "Missing"]);
    expect(result.unknownRecipeNames).toEqual(["Missing"]);
    expect(result.householdSize).toBe(3);
    expect(store.getHousehold).toHaveBeenCalledTimes(2);

    const recipesOrder = vi.mocked(store.getRecipes).mock.invocationCallOrder[0];
    const householdOrders = vi.mocked(store.getHousehold).mock.invocationCallOrder;
    const pantryOrder = vi.mocked(store.getPantry).mock.invocationCallOrder[0];
    expect(recipesOrder).toBeLessThan(householdOrders[0]);
    expect(householdOrders[0]).toBeLessThan(pantryOrder);
    expect(pantryOrder).toBeLessThan(householdOrders[1]);
  });

  it("returns the existing no-match domain outcome without later datastore reads", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe({ name: "Bolognese" })]);

    const result = await generateShoppingList({ recipeNames: ["Missing"] });

    expect(result).toEqual({
      status: "no-matching-recipes",
      requestedRecipeNames: ["Missing"],
      selectedRecipes: [],
      unknownRecipeNames: ["Missing"],
      availableRecipeNames: ["Bolognese"],
    });
    expect(store.getHousehold).not.toHaveBeenCalled();
    expect(store.getPantry).not.toHaveBeenCalled();
    expect(api.searchDealsBatch).not.toHaveBeenCalled();
  });

  it("propagates datastore errors without wrapping them", async () => {
    const expected = new Error("datastore busy");
    vi.mocked(store.getRecipes).mockRejectedValue(expected);

    await expect(generateShoppingList({ recipeNames: ["Bolognese"] })).rejects.toBe(expected);
  });
});
