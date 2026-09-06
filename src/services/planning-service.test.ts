import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Offer } from "../api.js";
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

vi.mock("./scoring-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scoring-service.js")>();
  return { ...actual, scoreRecipes: vi.fn(actual.scoreRecipes) };
});

vi.mock("./shopping-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shopping-service.js")>();
  return {
    ...actual,
    buildShoppingListForRecipes: vi.fn(actual.buildShoppingListForRecipes),
  };
});

const api = await import("../api.js");
const store = await import("../store.js");
const scoringService = await import("./scoring-service.js");
const shoppingService = await import("./shopping-service.js");
const { planAndShop } = await import("./planning-service.js");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "apples",
    heading: "Æbler",
    description: null,
    price: 20,
    prePrice: null,
    currency: "DKK",
    quantity: 1,
    unit: "kg",
    pricePerUnit: "20.00 kr/kg",
    store: "Netto",
    storeId: "n1",
    validFrom: "2026-06-10",
    validUntil: "2026-06-30T00:00:00Z",
    imageUrl: null,
    ...overrides,
  };
}

function makeRecipe(name: string, ingredientName: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    name,
    servings: 4,
    complexity: "medium",
    cuisineType: "italian",
    proteinType: "vegetarian",
    ingredients: [
      {
        name: ingredientName,
        quantity: "1 kg",
        searchTerms: [ingredientName.toLowerCase()],
        category: "produce",
      },
    ],
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

function options(overrides: Partial<Parameters<typeof planAndShop>[0]> = {}) {
  return {
    days: 2,
    maxPerProtein: 2,
    maxPerCuisine: 2,
    maxSlowDays: 2,
    ...overrides,
  };
}

function twoRecipeLibrary(): Recipe[] {
  return [
    makeRecipe("Beef", "Hakket oksekød", {
      proteinType: "beef",
      cuisineType: "danish",
      ingredients: [
        {
          name: "Hakket oksekød",
          quantity: "500 g",
          searchTerms: ["hakket oksekød"],
          category: "meat",
        },
      ],
    }),
    makeRecipe("Apples", "Æbler"),
  ];
}

function twoRecipeDeals(): Map<string, Offer[]> {
  return new Map([
    ["æbler", [makeOffer()]],
    [
      "hakket oksekød",
      [
        makeOffer({
          id: "beef",
          heading: "Hakket oksekød 8-12%",
          price: 40,
          quantity: 500,
          unit: "g",
          pricePerUnit: "80.00 kr/kg",
        }),
      ],
    ],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(store.getRecipes).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
});

describe("planAndShop", () => {
  it("returns a structured plan, estimate, and shopping result while preserving legacy order", async () => {
    const library = [
      ...twoRecipeLibrary(),
      makeRecipe("Apple chicken", "Æbler", {
        proteinType: "chicken",
        cuisineType: "asian",
      }),
    ];
    const dealMap = twoRecipeDeals();
    vi.mocked(store.getRecipes).mockResolvedValue(library);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(dealMap);

    const result = await planAndShop(
      options({ days: 3, maxPerProtein: 3, maxPerCuisine: 3, maxSlowDays: 3 }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a successful plan");
    expect(result.plan.map((day) => [day.day, day.recipeName])).toEqual([
      [1, "Apples"],
      [2, "Apple chicken"],
      [3, "Beef"],
    ]);
    expect(result.selectedRecipes.map((recipe) => recipe.name)).toEqual([
      "Beef",
      "Apples",
      "Apple chicken",
    ]);
    expect(result.shopping.selectedRecipes.map((recipe) => recipe.name)).toEqual([
      "Beef",
      "Apples",
      "Apple chicken",
    ]);
    expect(result.planningEstimate).toEqual({
      matchedDealPlanningEstimate: 30,
      sharedMatchedDealEstimateSavings: 10,
      uniqueMatchedDealIngredientCount: 2,
    });
    expect(result.shopping.status).toBe("ready");
    expect(scoringService.scoreRecipes).toHaveBeenCalledTimes(1);
    expect(shoppingService.buildShoppingListForRecipes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shoppingService.buildShoppingListForRecipes).mock.calls[0][2]).toBe(dealMap);
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);

    const householdOrder = vi.mocked(store.getHousehold).mock.invocationCallOrder;
    const pantryOrder = vi.mocked(store.getPantry).mock.invocationCallOrder;
    const recipesOrder = vi.mocked(store.getRecipes).mock.invocationCallOrder;
    expect(householdOrder).toHaveLength(2);
    expect(pantryOrder).toHaveLength(2);
    expect(recipesOrder).toHaveLength(2);
    expect(householdOrder[0]).toBeLessThan(pantryOrder[0]);
    expect(pantryOrder[0]).toBeLessThan(recipesOrder[0]);
    expect(recipesOrder[0]).toBeLessThan(recipesOrder[1]);
    expect(recipesOrder[1]).toBeLessThan(pantryOrder[1]);
    expect(pantryOrder[1]).toBeLessThan(householdOrder[1]);
  });

  it("forwards protein constraints to the existing optimizer", async () => {
    const library = [
      makeRecipe("Cheap beef", "Cheap beef", { proteinType: "beef" }),
      makeRecipe("Second beef", "Second beef", { proteinType: "beef" }),
      makeRecipe("Chicken", "Chicken", { proteinType: "chicken", cuisineType: "asian" }),
    ];
    vi.mocked(store.getRecipes).mockResolvedValue(library);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["cheap beef", [makeOffer({ id: "b1", heading: "Cheap beef", price: 10 })]],
        ["second beef", [makeOffer({ id: "b2", heading: "Second beef", price: 12 })]],
        ["chicken", [makeOffer({ id: "c1", heading: "Chicken", price: 40 })]],
      ]),
    );

    const result = await planAndShop(options({ maxPerProtein: 1, maxPerCuisine: 2 }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a successful plan");
    expect(result.plan.map((day) => day.recipe.proteinType).sort()).toEqual(["beef", "chicken"]);
    expect(result.constraints.maxPerProtein).toBe(1);
  });

  it("forwards cuisine constraints to the existing optimizer", async () => {
    const library = [
      makeRecipe("Cheap Italian", "Cheap Italian", {
        proteinType: "beef",
        cuisineType: "italian",
      }),
      makeRecipe("Second Italian", "Second Italian", {
        proteinType: "chicken",
        cuisineType: "italian",
      }),
      makeRecipe("Asian", "Asian", { proteinType: "pork", cuisineType: "asian" }),
    ];
    vi.mocked(store.getRecipes).mockResolvedValue(library);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["cheap italian", [makeOffer({ id: "i1", heading: "Cheap Italian", price: 10 })]],
        ["second italian", [makeOffer({ id: "i2", heading: "Second Italian", price: 12 })]],
        ["asian", [makeOffer({ id: "a1", heading: "Asian", price: 40 })]],
      ]),
    );

    const result = await planAndShop(options({ maxPerProtein: 2, maxPerCuisine: 1 }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a successful plan");
    expect(result.plan.map((day) => day.recipe.cuisineType).sort()).toEqual(["asian", "italian"]);
    expect(result.constraints.maxPerCuisine).toBe(1);
  });

  it("returns an insufficient-recipes outcome without mapping or shopping", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe("Only", "Æbler")]);

    const result = await planAndShop(options({ days: 2 }));

    expect(result).toMatchObject({
      status: "insufficient-recipes",
      days: 2,
      availableRecipeCount: 1,
      householdSize: 2,
      country: "DK",
      currency: "DKK",
    });
    expect(store.getRecipes).toHaveBeenCalledTimes(1);
    expect(shoppingService.buildShoppingListForRecipes).not.toHaveBeenCalled();
  });

  it("represents an empty recipe library as an insufficient-recipes outcome", async () => {
    const result = await planAndShop(options({ days: 1 }));

    expect(result).toMatchObject({
      status: "insufficient-recipes",
      availableRecipeCount: 0,
    });
    expect(api.searchDealsBatch).not.toHaveBeenCalled();
    expect(shoppingService.buildShoppingListForRecipes).not.toHaveBeenCalled();
  });

  it("returns a no-valid-plan outcome without mapping or shopping", async () => {
    const library = [
      makeRecipe("Beef one", "Beef one", { proteinType: "beef" }),
      makeRecipe("Beef two", "Beef two", { proteinType: "beef" }),
    ];
    vi.mocked(store.getRecipes).mockResolvedValue(library);

    const result = await planAndShop(options({ maxPerProtein: 1 }));

    expect(result).toMatchObject({ status: "no-valid-plan", days: 2 });
    expect(store.getRecipes).toHaveBeenCalledTimes(1);
    expect(shoppingService.buildShoppingListForRecipes).not.toHaveBeenCalled();
  });

  it("applies a people override to scoring and structured shopping quantities", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe("Apples", "Æbler")]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["æbler", [makeOffer({ quantity: 1, unit: "kg" })]]]),
    );

    const result = await planAndShop(options({ days: 1, people: 8 }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a successful plan");
    expect(scoringService.scoreRecipes).toHaveBeenCalledWith({ people: 8 });
    expect(result.householdSize).toBe(8);
    expect(result.shopping.householdSize).toBe(8);
    expect(result.shopping.items[0].quantity.aggregated).toEqual({ totalAmount: 2000, unit: "g" });
  });

  it("reuses an exact empty deal map without a second deal fetch", async () => {
    const emptyDealMap = new Map<string, Offer[]>();
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe("Apples", "Æbler")]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(emptyDealMap);

    const result = await planAndShop(options({ days: 1 }));

    expect(result.status).toBe("ok");
    expect(vi.mocked(shoppingService.buildShoppingListForRecipes).mock.calls[0][2]).toBe(
      emptyDealMap,
    );
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);
  });

  it("propagates unexpected mapping errors without building shopping data", async () => {
    const error = new Error("mapping read failed");
    vi.mocked(store.getRecipes)
      .mockResolvedValueOnce(twoRecipeLibrary())
      .mockRejectedValueOnce(error);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(twoRecipeDeals());

    await expect(planAndShop(options())).rejects.toBe(error);
    expect(shoppingService.buildShoppingListForRecipes).not.toHaveBeenCalled();
  });

  it("propagates unexpected shopping errors unchanged", async () => {
    const error = new Error("shopping failed");
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe("Apples", "Æbler")]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["æbler", [makeOffer()]]]));
    vi.mocked(shoppingService.buildShoppingListForRecipes).mockRejectedValueOnce(error);

    await expect(planAndShop(options({ days: 1 }))).rejects.toBe(error);
  });
});
