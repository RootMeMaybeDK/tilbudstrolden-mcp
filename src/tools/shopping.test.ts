/**
 * Unit tests for src/tools/shopping.ts — generate_shopping_list and plan_and_shop.
 *
 * The api and store layers are mocked; src/scoring.ts and src/tools/scoring.ts
 * run for real, so quantity aggregation, whole-pack costing, store grouping,
 * and the weekly optimiser are all exercised end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
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

const api = await import("../api.js");
const store = await import("../store.js");
const { buildShoppingListResult } = await import("./shopping-list.js");
const { registerShoppingTools } = await import("./shopping.js");

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

function makeHousehold(overrides: Partial<Household> = {}): Household {
  return {
    people: [],
    stores: [],
    defaultServings: 2,
    country: "DK",
    ...overrides,
  };
}

function beefRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "Bolognese",
    servings: 4,
    complexity: "medium",
    cuisineType: "italian",
    proteinType: "beef",
    ingredients: [
      {
        name: "Hakket oksekød",
        quantity: "500g",
        searchTerms: ["hakket oksekød"],
        category: "meat",
      },
    ],
    ...overrides,
  };
}

const beefDeals = () => new Map([["hakket oksekød", [makeOffer()]]]);

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
  stub = createServerStub();
  registerShoppingTools(stub.server);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerShoppingTools", () => {
  it("registers both shopping tools", () => {
    expect([...stub.tools.keys()].sort()).toEqual(["generate_shopping_list", "plan_and_shop"]);
  });

  it("tells the model when not to use each tool", () => {
    for (const tool of stub.tools.values()) {
      expect(tool.description, `${tool.name} description`).toContain("USE WHEN");
      expect(tool.description, `${tool.name} description`).toContain("NOT FOR");
      expect(tool.description, `${tool.name} description`).toContain("not a full basket total");
    }
  });
});

describe("generate_shopping_list", () => {
  it("lists what is available when no recipe name matches", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe({ name: "Bolognese" })]);
    const text = textOf(await callTool(stub, "generate_shopping_list", { recipes: ["Sushi"] }));
    expect(text).toBe("No matching recipes found. Available: Bolognese");
  });

  it("points at add_recipe when the library is empty", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "generate_shopping_list", { recipes: ["Sushi"] }));
    expect(text).toBe("No matching recipes found. Available: none (add recipes first)");
  });

  it("matches recipe names case-insensitively", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["bOLOGNESE"],
      }),
    );
    expect(text).toContain("Shopping list for: Bolognese");
  });

  it("groups matched items under their store with pack maths and leftovers", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("Shopping list for: Bolognese (2 people)");
    expect(text).toContain("Matched-deal purchase subtotal: 45 DKK (not a full basket total)");
    expect(text).toContain("Confirmed deal subtotal: 45 DKK");
    expect(text).toContain("Uncertain-match subtotal: 0 DKK");
    expect(text).toContain("Confirmed matches: 1");
    expect(text).toContain("Uncertain matches: 0");
    expect(text).toContain("Items without matched deal price: 0");
    expect(text).not.toContain("Estimated register total");
    expect(text).toContain("## Netto (1 items)");
    // 500 g recipe quantity scaled from 4 servings to 2 people = 250 g needed,
    // bought as one 500 g pack at 45 kr, leaving 250 g over.
    expect(text).toContain("1. Hakket oksekød: need 250 g -> 45 kr = 45 kr");
    expect(text).toContain("[500 g/pack, 90.00 kr/kg]");
    expect(text).toContain("(250 g leftover)");
    expect(text).toContain("-- Hakket oksekød 8-12% @ Netto until 2026-06-30");
  });

  it("passes dealer IDs to retrieval and groups a foetex/Føtex ID match", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "foetex", dealerId: "bdf5A", priority: 1 }],
      }),
    );
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [makeOffer({ store: "Føtex", storeId: "bdf5A" })]]]),
    );

    const text = textOf(await callTool(stub, "generate_shopping_list", { recipes: ["Bolognese"] }));
    const [, limit, , options] = vi.mocked(api.searchDealsBatch).mock.calls[0];

    expect(limit).toBe(8);
    expect(options?.dealerIds).toEqual(new Set(["bdf5A"]));
    expect(text).toContain("## Føtex (1 items)");
  });

  it("does not group an offer whose display name matches but dealer ID is wrong", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "Føtex", dealerId: "bdf5A", priority: 1 }],
      }),
    );
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [makeOffer({ store: "Føtex", storeId: "wrong-id" })]]]),
    );

    const text = textOf(await callTool(stub, "generate_shopping_list", { recipes: ["Bolognese"] }));

    expect(text).not.toContain("## Føtex");
    expect(text).toContain("## Buy at regular price (1 items)");
  });

  it("honours an explicit people override", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
        people: 8,
      }),
    );
    expect(text).toContain("(8 people)");
    // 500 g at 4 servings scaled to 8 people = 1 kg -> two 500 g packs.
    expect(text).toContain("need 1 kg -> 2 x 45 kr = 90 kr");
  });

  it("aggregates a shared ingredient across recipes and shows the arithmetic", async () => {
    const recipes = [
      beefRecipe({ name: "Bolognese" }),
      beefRecipe({ name: "Chili", cuisineType: "mexican" }),
    ];
    vi.mocked(store.getRecipes).mockResolvedValue(recipes);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese", "Chili"],
      }),
    );
    expect(text).toContain("Shopping list for: Bolognese, Chili");
    expect(text).toContain("need 250 g + 250 g = 500 g");
    // One 500 g pack covers both recipes.
    expect(text).toContain("-> 45 kr = 45 kr");

    const result = await buildShoppingListResult(recipes, 2);
    expect(result.matchSummary).toEqual({
      eligibleItemCount: 1,
      confirmedMatchCount: 1,
      lowConfidenceMatchCount: 0,
      unmatchedItemCount: 0,
      confirmedCoveragePercent: 100,
      candidateCoveragePercent: 100,
    });
    expect(result.priceSummary).toEqual({
      confirmedPurchaseSubtotal: 45,
      uncertainPurchaseSubtotal: 0,
      matchedPurchaseSubtotal: 45,
      currency: "DKK",
    });
    expect(result.grandTotal).toBe(45);
  });

  it("keeps Tomatrisotto's fractional lemon requirement separate from purchase quantity", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        name: "Tomatrisotto",
        servings: 4,
        proteinType: "vegetarian",
        ingredients: [
          {
            name: "Citron",
            quantity: "0.5 stk",
            searchTerms: ["citron"],
            category: "produce",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "citron",
          [
            makeOffer({
              id: "lemon",
              heading: "Citron",
              price: 5,
              quantity: 1,
              unit: "stk",
              pricePerUnit: null,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Tomatrisotto"],
        people: 3,
      }),
    );

    expect(text).toContain("Citron: need 0.375 stk -> 5 kr = 5 kr");
    expect(text).toContain("[1 stk/pack]");
    expect(text).not.toContain("need 0 stk");
  });

  it("shows fractional contributions before aggregation", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        name: "Recipe A",
        servings: 4,
        ingredients: [
          {
            name: "Citron",
            quantity: "0.5 stk",
            searchTerms: ["citron"],
            category: "produce",
          },
        ],
      }),
      beefRecipe({
        name: "Recipe B",
        servings: 4,
        ingredients: [
          {
            name: "Citron",
            quantity: "0.5 stk",
            searchTerms: ["citron"],
            category: "produce",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "citron",
          [
            makeOffer({
              id: "lemon",
              heading: "Citron",
              price: 5,
              quantity: 1,
              unit: "stk",
              pricePerUnit: null,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Recipe A", "Recipe B"],
        people: 3,
      }),
    );

    expect(text).toContain("need 0.375 stk + 0.375 stk = 0.75 stk");
  });

  it.each([
    ["Olivenolie", "2 spsk", 500, "ml"],
    ["Hvidløg", "2 fed", 1, "stk"],
  ])("uses sticker-price fallback for semantic quantity %s against an incompatible offer pack", async (name, quantity, offerQuantity, offerUnit) => {
    const recipe = beefRecipe({
      ingredients: [
        {
          name,
          quantity,
          searchTerms: [name.toLowerCase()],
          category: "produce",
        },
      ],
    });
    vi.mocked(store.getRecipes).mockResolvedValue([recipe]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          name.toLowerCase(),
          [
            makeOffer({
              id: name,
              heading: name,
              price: 8,
              quantity: offerQuantity,
              unit: offerUnit,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
        people: 4,
      }),
    );

    expect(text).toContain(`${name} (${quantity}): ${name} - 8 DKK`);
    expect(text).not.toContain("/pack");
    expect(text).toContain("Matched-deal purchase subtotal: 8 DKK");
  });

  it("uses metric pack calculation for a liter recipe quantity", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Grøntsagsbouillon",
            quantity: "1 liter",
            searchTerms: ["grøntsagsbouillon"],
            category: "pantry",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "grøntsagsbouillon",
          [
            makeOffer({
              id: "stock",
              heading: "Grøntsagsbouillon",
              price: 10,
              quantity: 500,
              unit: "ml",
              pricePerUnit: "20.00 kr/L",
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
        people: 4,
      }),
    );

    expect(text).toContain("Grøntsagsbouillon: need 1 L -> 2 x 10 kr = 20 kr");
    expect(text).toContain("[5 dl/pack, 20.00 kr/L]");
  });

  it("scales mixed-unit contributions but falls back once without first-item pack maths", async () => {
    const recipes = [
      beefRecipe({
        name: "Recipe A",
        ingredients: [
          {
            name: "Bacon",
            quantity: "250 g",
            searchTerms: ["bacon"],
            category: "meat",
          },
        ],
      }),
      beefRecipe({
        name: "Recipe B",
        ingredients: [
          {
            name: "Bacon",
            quantity: "3 skiver",
            searchTerms: ["bacon"],
            category: "meat",
          },
        ],
      }),
    ];
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "bacon",
          [makeOffer({ id: "bacon", heading: "Bacon", price: 20, quantity: 200, unit: "g" })],
        ],
      ]),
    );

    const result = await buildShoppingListResult(recipes, 3);

    expect(result.text).toContain("Bacon (187.5 g + 2.25 skiver): Bacon - 20 DKK");
    expect(result.text).not.toContain("Bacon: need");
    expect(result.text).not.toContain("/pack");
    expect(result.text).not.toContain("187.5 g + 2.25 skiver =");
    expect(result.grandTotal).toBe(20);
  });

  it("aggregates the same semantic unit and uses one sticker-price fallback", async () => {
    const recipes = [
      beefRecipe({
        name: "Recipe A",
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "2 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
        ],
      }),
      beefRecipe({
        name: "Recipe B",
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "1 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
        ],
      }),
    ];
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "hvidløg",
          [makeOffer({ id: "garlic", heading: "Hvidløg", price: 8, quantity: 1, unit: "stk" })],
        ],
      ]),
    );

    const result = await buildShoppingListResult(recipes, 4);

    expect(result.text).toContain("Hvidløg (2 fed + 1 fed = 3 fed): Hvidløg - 8 DKK");
    expect(result.text).not.toContain("/pack");
    expect(result.grandTotal).toBe(8);
  });

  it("puts unmatched ingredients in the regular-price section with their source recipes", async () => {
    const recipes = [
      beefRecipe({
        ingredients: [
          {
            name: "Enhjørning",
            quantity: "1 stk",
            searchTerms: ["enhjørning"],
            category: "meat",
          },
        ],
      }),
    ];
    vi.mocked(store.getRecipes).mockResolvedValue(recipes);
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## Buy at regular price (1 items)");
    expect(text).toContain("- Enhjørning (0.5 stk) [Bolognese]");
    expect(text).toContain("Matched-deal purchase subtotal: 0 DKK");
    expect(text).toContain("Items without matched deal price: 1");

    const result = await buildShoppingListResult(recipes, 2);
    expect(result.matchSummary).toEqual({
      eligibleItemCount: 1,
      confirmedMatchCount: 0,
      lowConfidenceMatchCount: 0,
      unmatchedItemCount: 1,
      confirmedCoveragePercent: 0,
      candidateCoveragePercent: 0,
    });
    expect(result.priceSummary.matchedPurchaseSubtotal).toBe(0);
    expect(result.grandTotal).toBe(0);
  });

  it("skips pantry ingredients and names them at the bottom", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hakket oksekød",
            quantity: "500g",
            searchTerms: ["hakket oksekød"],
            category: "meat",
          },
          {
            name: "Salt",
            quantity: "1 tsk",
            searchTerms: ["salt"],
            category: "pantry",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## Skipped (in pantry): Salt");
    expect(text).not.toContain("- Salt (1 tsk)");
  });

  it("includes pantry items when excludePantry is false", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Salt",
            quantity: "1 tsk",
            searchTerms: ["salt"],
            category: "pantry",
          },
        ],
      }),
    ]);
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
        excludePantry: false,
      }),
    );
    expect(text).toContain("- Salt (0.5 tsk) [Bolognese]");
    expect(text).not.toContain("Skipped (in pantry)");
  });

  it("says so when every ingredient is already in the pantry", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Salt",
            quantity: "1 tsk",
            searchTerms: ["salt"],
            category: "pantry",
          },
        ],
      }),
    ]);
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toBe("All ingredients are in your pantry. Nothing to buy!");

    const result = await buildShoppingListResult(
      [
        beefRecipe({
          ingredients: [
            {
              name: "Salt",
              quantity: "1 tsk",
              searchTerms: ["salt"],
              category: "pantry",
            },
          ],
        }),
      ],
      2,
    );
    expect(result.matchSummary).toMatchObject({
      eligibleItemCount: 0,
      confirmedCoveragePercent: 100,
      candidateCoveragePercent: 100,
    });
    expect(result.priceSummary.matchedPurchaseSubtotal).toBe(0);
  });

  it("raises a buy-first section for deals expiring within two days", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [makeOffer({ validUntil: "2026-06-16T00:00:00Z" })]]]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## ⏰ Buy first (expiring soon)");
    expect(text).toContain("- Hakket oksekød: deal at Netto [expires today] (2026-06-16)");
  });

  it("surfaces alternatives for a low-confidence match", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Mælk",
            quantity: "5 dl",
            searchTerms: ["mælk"],
            category: "other",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "mælk",
          [
            makeOffer({
              id: "m1",
              heading: "Øko mælk eller fløde",
              price: 12,
              quantity: 1,
              unit: "l",
            }),
            makeOffer({
              id: "m2",
              heading: "Sød mælk eller kærnemælk",
              price: 14,
              quantity: 1,
              unit: "l",
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## ⚠ Uncertain matches (verify these)");
    expect(text).toContain('Mælk: picked "Øko mælk eller fløde" but also found:');
    expect(text).toContain("Sød mælk eller kærnemælk");
  });

  it("counts a single-candidate low-confidence match and its pack cost", async () => {
    const recipes = [
      beefRecipe({
        ingredients: [
          {
            name: "Mælk",
            quantity: "5 dl",
            searchTerms: ["mælk"],
            category: "other",
          },
        ],
      }),
    ];
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
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

    const result = await buildShoppingListResult(recipes, 2);

    expect(result.matchSummary).toEqual({
      eligibleItemCount: 1,
      confirmedMatchCount: 0,
      lowConfidenceMatchCount: 1,
      unmatchedItemCount: 0,
      confirmedCoveragePercent: 0,
      candidateCoveragePercent: 100,
    });
    expect(result.priceSummary).toEqual({
      confirmedPurchaseSubtotal: 0,
      uncertainPurchaseSubtotal: 12,
      matchedPurchaseSubtotal: 12,
      currency: "DKK",
    });
    expect(result.grandTotal).toBe(12);
    expect(result.text).toContain("= 12 kr");
    expect(result.text).toContain("⚠");
    expect(result.text).toContain("Uncertain matches: 1");
  });

  it("reports high, low, and unmatched shopping items separately", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hakket oksekød",
            quantity: "500g",
            searchTerms: ["hakket oksekød"],
            category: "meat",
          },
          {
            name: "Mælk",
            quantity: "5 dl",
            searchTerms: ["mælk"],
            category: "other",
          },
          {
            name: "Enhjørning",
            quantity: "1 stk",
            searchTerms: ["enhjørning"],
            category: "other",
          },
        ],
      }),
    ]);
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

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );

    expect(text).toContain("Matched-deal purchase subtotal: 57 DKK");
    expect(text).toContain("Confirmed deal subtotal: 45 DKK");
    expect(text).toContain("Uncertain-match subtotal: 12 DKK");
    expect(text).toContain("Confirmed matches: 1");
    expect(text).toContain("Uncertain matches: 1");
    expect(text).toContain("Items without matched deal price: 1");
    expect(text).toContain("## Buy at regular price (1 items)");
    expect(text).not.toContain("Estimated register total");
  });

  it("keeps ordered half-cent sticker fallbacks aligned with legacy grandTotal", async () => {
    const recipes = [
      beefRecipe({
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "3 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
          {
            name: "Mælk",
            quantity: "3 fed",
            searchTerms: ["mælk"],
            category: "other",
          },
          {
            name: "Kartofler",
            quantity: "3 fed",
            searchTerms: ["kartofler"],
            category: "produce",
          },
        ],
      }),
    ];
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hvidløg", [makeOffer({ id: "garlic", heading: "Hvidløg", price: 39.91 })]],
        ["mælk", [makeOffer({ id: "milk", heading: "Øko mælk eller fløde", price: 54.835 })]],
        ["kartofler", [makeOffer({ id: "potatoes", heading: "Kartofler", price: 63.36 })]],
      ]),
    );

    const result = await buildShoppingListResult(recipes, 2);
    const { priceSummary } = result;

    expect(priceSummary).toEqual({
      confirmedPurchaseSubtotal: 103.27,
      uncertainPurchaseSubtotal: 54.84,
      matchedPurchaseSubtotal: 158.11,
      currency: "DKK",
    });
    expect(
      toMinorUnits(priceSummary.confirmedPurchaseSubtotal) +
        toMinorUnits(priceSummary.uncertainPurchaseSubtotal),
    ).toBe(toMinorUnits(priceSummary.matchedPurchaseSubtotal));
    expect(toMinorUnits(priceSummary.matchedPurchaseSubtotal)).toBe(
      toMinorUnits(result.grandTotal),
    );
  });

  it("falls back to the sticker price when a semantic unit is pack-incompatible", async () => {
    // "2 fed" can be scaled as a recipe requirement but cannot be converted
    // to the offer's stk unit, so the line uses the raw offer price.
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "2 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "hvidløg",
          [
            makeOffer({
              id: "g1",
              heading: "Hvidløg",
              price: 8,
              quantity: 3,
              unit: "stk",
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain(
      "Hvidløg (1 fed): Hvidløg - 8 DKK (90.00 kr/kg) @ Netto until 2026-06-30",
    );
    expect(text).not.toContain("/pack");
    expect(text).toContain("Matched-deal purchase subtotal: 8 DKK");
  });

  it("omits the unit price from the fallback line when the offer has none", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "2 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "hvidløg",
          [
            makeOffer({
              id: "g1",
              heading: "Hvidløg",
              price: 8,
              quantity: 3,
              unit: "stk",
              pricePerUnit: null,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("Hvidløg (1 fed): Hvidløg - 8 DKK @ Netto until 2026-06-30");
  });

  it("returns a structured error when the deal lookup fails", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockRejectedValue(new Error("upstream 500"));
    const result = await callTool(stub, "generate_shopping_list", {
      recipes: ["Bolognese"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to generate shopping list: upstream 500");
  });

  it("rejects a call with no recipes array", async () => {
    await expect(callTool(stub, "generate_shopping_list", {})).rejects.toThrow();
  });
});

describe("plan_and_shop", () => {
  function library(count: number): Recipe[] {
    const proteins = ["beef", "chicken", "pork", "fish", "vegetarian", "lamb", "shellfish"];
    const cuisines = ["italian", "asian", "danish", "mexican", "french", "indian", "greek"];
    return Array.from({ length: count }, (_, i) =>
      beefRecipe({
        name: `Recipe ${i + 1}`,
        proteinType: proteins[i % proteins.length],
        cuisineType: cuisines[i % cuisines.length],
      }),
    );
  }

  it("refuses with a count when there are fewer recipes than days", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(2));
    const result = await callTool(stub, "plan_and_shop", { days: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Need at least 5 recipes to plan 5 days, but only 2 recipes exist. Add more with add_recipe.",
    );
  });

  it("defaults to a 7-day plan", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(3));
    const result = await callTool(stub, "plan_and_shop", {});
    expect(textOf(result)).toContain("Need at least 7 recipes to plan 7 days");
  });

  it("explains which knobs to relax when no plan satisfies the constraints", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef" }),
      beefRecipe({ name: "B", proteinType: "beef" }),
    ]);
    const result = await callTool(stub, "plan_and_shop", {
      days: 2,
      maxPerProtein: 1,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not find a valid meal plan");
    expect(textOf(result)).toContain("maxPerProtein");
  });

  it("returns a day-by-day plan followed by the shopping list", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(3));
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(await callTool(stub, "plan_and_shop", { days: 3 }));
    expect(text).toContain("# 3-day meal plan (2 people)");
    expect(text).toContain("Matched-deal planning estimate (not a full basket total): ~");
    expect(text).not.toContain("Estimated basket:");
    expect(text).toContain("Day 1:");
    expect(text).toContain("Day 3:");
    expect(text).not.toContain("Day 4:");
    expect(text).toContain("Day 1: Recipe 1");
    expect(text).toContain("Day 2: Recipe 2");
    expect(text).toContain("Day 3: Recipe 3");
    // Plan and shopping list are separated by a horizontal rule.
    const divider = text.indexOf("\n---\n");
    expect(divider).toBeGreaterThan(-1);
    expect(text.slice(divider)).toContain("Shopping list for:");
    expect(text.slice(divider)).toContain("Matched-deal purchase subtotal:");
    expect(text.slice(divider)).toContain("## Netto");
  });

  it("reuses the cached deal map rather than searching twice", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(3));
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());
    await callTool(stub, "plan_and_shop", { days: 3 });
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);
  });

  it("honours a people override in both the header and the quantities", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(2));
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(await callTool(stub, "plan_and_shop", { days: 2, people: 8 }));
    expect(text).toContain("# 2-day meal plan (8 people)");
    expect(text).toContain("(8 people)");
  });

  it("excludes a protein from the plan when asked", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "Beefy", proteinType: "beef" }),
      beefRecipe({ name: "Chicken", proteinType: "chicken" }),
      beefRecipe({ name: "Veggie", proteinType: "vegetarian" }),
    ]);
    const text = textOf(
      await callTool(stub, "plan_and_shop", {
        days: 2,
        excludeProteins: ["beef"],
      }),
    );
    const planSection = text.slice(0, text.indexOf("\n---\n"));
    expect(planSection).not.toContain("Beefy");
  });

  it("returns a structured error when the household lookup fails", async () => {
    vi.mocked(store.getHousehold).mockRejectedValue(new Error("disk error"));
    const result = await callTool(stub, "plan_and_shop", { days: 2 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to plan: disk error");
  });
});
