/**
 * Unit tests for src/tools/scoring.ts — scoreAllRecipes and the score_recipes tool.
 *
 * The api and store layers are mocked; src/scoring.ts (matching, costing,
 * weekly optimisation) runs for real, so these exercise the whole scoring
 * pipeline from a recipe library down to rendered output.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
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
const { registerScoringTools, scoreAllRecipes } = await import("./scoring.js");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-1",
    heading: "Mælk 1L",
    description: null,
    price: 12,
    prePrice: null,
    currency: "DKK",
    quantity: 1,
    unit: "l",
    pricePerUnit: "12.00 kr/L",
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

/** Recipe whose single ingredient matches "Hakket oksekød" at high confidence. */
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

const beefOffer = makeOffer({
  id: "beef",
  heading: "Hakket oksekød 8-12%",
  price: 45,
  quantity: 500,
  unit: "g",
  pricePerUnit: "90.00 kr/kg",
});

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
  stub = createServerStub();
  registerScoringTools(stub.server);
});

describe("scoreAllRecipes", () => {
  it("short-circuits without hitting the API when there are no recipes", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const result = await scoreAllRecipes(new Set(), new Set(), 2);
    expect(result.scored).toEqual([]);
    expect(result.dealMap.size).toBe(0);
    expect(api.searchDealsBatch).not.toHaveBeenCalled();
  });

  it("batches every expanded search term once, at the locale's country", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Oksefars",
            quantity: "500g",
            searchTerms: ["oksefars"],
            category: "meat",
          },
          {
            name: "Løg",
            quantity: "2 stk",
            searchTerms: ["løg"],
            category: "produce",
          },
        ],
      }),
    ]);
    await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));

    const [terms, limit, country] = vi.mocked(api.searchDealsBatch).mock.calls[0];
    // "oksefars" expands to include the "hakket oksekød" synonym.
    expect(terms).toContain("oksefars");
    expect(terms).toContain("hakket oksekød");
    expect(terms).toContain("løg");
    expect(new Set(terms).size).toBe(terms.length);
    expect(limit).toBe(8);
    expect(country).toBe("DK");
  });

  it("caps the internal candidate budget at the upstream limit", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    const preferredStores = Array.from({ length: 20 }, (_, index) => ({
      name: `Store ${index}`,
      dealerId: `dealer-${index}`,
    }));

    await scoreAllRecipes(preferredStores, new Set(), 2, getLocale("DK"));
    const [, limit, , options] = vi.mocked(api.searchDealsBatch).mock.calls[0];

    expect(limit).toBe(100);
    expect(options?.dealerIds?.size).toBe(20);
  });

  it("excludes pantry ingredients from both the search and the coverage denominator", async () => {
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
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const { scored } = await scoreAllRecipes(new Set(), new Set(["salt"]), 2, getLocale("DK"));

    expect(vi.mocked(api.searchDealsBatch).mock.calls[0][0]).not.toContain("salt");
    expect(scored[0].ingredients.map((i) => i.name)).toEqual(["Hakket oksekød"]);
    // 1 of 1 non-pantry ingredient matched.
    expect(scored[0].dealCoverage).toBe(100);
  });

  it("costs a matched ingredient by unit price scaled to household size", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    const ing = scored[0].ingredients[0];

    expect(ing.confidence).toBe("high");
    expect(ing.bestDeal).toEqual({
      heading: "Hakket oksekød 8-12%",
      price: 22.5,
      store: "Netto",
    });
    // 45 kr / 500 g = 0.09 kr/g; 500 g scaled by 2/4 servings = 250 g -> 22.50 kr
    expect(scored[0].estimatedCost).toBe(22.5);
  });

  it("reports zero coverage and zero cost when nothing matches", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    expect(scored[0].dealCoverage).toBe(0);
    expect(scored[0].estimatedCost).toBe(0);
    expect(scored[0].ingredients[0].bestDeal).toBeNull();
    expect(scored[0].ingredients[0].confidence).toBe("none");
    expect(scored[0].matchSummary).toEqual({
      eligibleItemCount: 1,
      confirmedMatchCount: 0,
      lowConfidenceMatchCount: 0,
      unmatchedItemCount: 1,
      confirmedCoveragePercent: 0,
      candidateCoveragePercent: 0,
    });
    expect(scored[0].priceSummary).toEqual({
      confirmedDealEstimate: 0,
      uncertainDealEstimate: 0,
      matchedDealEstimate: 0,
      currency: "DKK",
    });
  });

  it("treats an all-pantry recipe as fully covered rather than dividing by zero", async () => {
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
    const { scored } = await scoreAllRecipes(new Set(), new Set(["salt"]), 2, getLocale("DK"));
    expect(scored[0].dealCoverage).toBe(100);
    expect(scored[0].ingredients).toEqual([]);
    expect(scored[0].matchSummary).toMatchObject({
      eligibleItemCount: 0,
      confirmedCoveragePercent: 100,
      candidateCoveragePercent: 100,
    });
  });

  it("splits high, low, and unmatched recipe values without changing legacy fields", async () => {
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
        ["hakket oksekød", [beefOffer]],
        ["mælk", [makeOffer({ id: "milk", heading: "Øko mælk eller fløde", price: 12 })]],
      ]),
    );

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    const recipe = scored[0];

    expect(recipe.matchSummary).toEqual({
      eligibleItemCount: 3,
      confirmedMatchCount: 1,
      lowConfidenceMatchCount: 1,
      unmatchedItemCount: 1,
      confirmedCoveragePercent: 33,
      candidateCoveragePercent: 67,
    });
    expect(recipe.priceSummary).toEqual({
      confirmedDealEstimate: 22.5,
      uncertainDealEstimate: 3,
      matchedDealEstimate: 25.5,
      currency: "DKK",
    });
    expect(recipe.estimatedCost).toBe(25.5);
    expect(recipe.dealCoverage).toBe(67);
  });

  it("keeps a repeating-decimal sticker fallback aligned with legacy estimatedCost", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        servings: 3,
        ingredients: [
          {
            name: "Hakket oksekød",
            quantity: "3 fed",
            searchTerms: ["hakket oksekød"],
            category: "meat",
          },
          {
            name: "Mælk",
            quantity: "3 fed",
            searchTerms: ["mælk"],
            category: "other",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hakket oksekød", [{ ...beefOffer, price: 10 }]],
        ["mælk", [makeOffer({ id: "milk", heading: "Øko mælk eller fløde", price: 10 })]],
      ]),
    );

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 1, getLocale("DK"));
    const recipe = scored[0];
    const summary = recipe.priceSummary;
    if (!summary) throw new Error("Expected recipe price summary");

    for (const ingredient of recipe.ingredients) {
      expect(ingredient.estimatedCost).toBeCloseTo(10 / 3, 12);
    }
    expect(summary).toEqual({
      confirmedDealEstimate: 3.33,
      uncertainDealEstimate: 3.34,
      matchedDealEstimate: 6.67,
      currency: "DKK",
    });
    expect(recipe.estimatedCost).toBe(6.67);
    expect(toMinorUnits(summary.matchedDealEstimate)).toBe(toMinorUnits(recipe.estimatedCost));
    expect(
      toMinorUnits(summary.confirmedDealEstimate) + toMinorUnits(summary.uncertainDealEstimate),
    ).toBe(toMinorUnits(summary.matchedDealEstimate));
  });

  it("preserves ingredient order when sticker fallbacks land on a half-cent boundary", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        servings: 2,
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
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hvidløg", [makeOffer({ id: "garlic", heading: "Hvidløg", price: 79.82 })]],
        ["mælk", [makeOffer({ id: "milk", heading: "Øko mælk eller fløde", price: 109.67 })]],
        ["kartofler", [makeOffer({ id: "potatoes", heading: "Kartofler", price: 126.72 })]],
      ]),
    );

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 1, getLocale("DK"));
    const recipe = scored[0];
    const summary = recipe.priceSummary;
    if (!summary) throw new Error("Expected recipe price summary");

    expect(recipe.ingredients.map((ingredient) => ingredient.estimatedCost)).toEqual([
      39.91, 54.835, 63.36,
    ]);
    expect(recipe.estimatedCost).toBe(158.11);
    expect(summary).toEqual({
      confirmedDealEstimate: 103.27,
      uncertainDealEstimate: 54.84,
      matchedDealEstimate: 158.11,
      currency: "DKK",
    });
    expect(toMinorUnits(summary.matchedDealEstimate)).toBe(toMinorUnits(recipe.estimatedCost));
    expect(
      toMinorUnits(summary.confirmedDealEstimate) + toMinorUnits(summary.uncertainDealEstimate),
    ).toBe(toMinorUnits(summary.matchedDealEstimate));
  });

  it("attaches alternative candidates only for low-confidence matches", async () => {
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
    // "øko mælk eller fløde" is a bundle heading with a non-leading match,
    // which scores below the confident threshold.
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "mælk",
          [
            makeOffer({ id: "m1", heading: "Øko mælk eller fløde", price: 12 }),
            makeOffer({
              id: "m2",
              heading: "Sød mælk eller kærnemælk",
              price: 14,
            }),
          ],
        ],
      ]),
    );

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    const ing = scored[0].ingredients[0];
    expect(ing.confidence).toBe("low");
    expect(ing.candidates).toBeDefined();
    expect(ing.candidates?.length).toBeGreaterThan(1);
    expect(ing.candidates?.[0]).toMatchObject({ store: "Netto" });
  });

  it("sorts by deal coverage first, then by cost", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "NoDeals" }),
      beefRecipe({ name: "Covered" }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    // Both recipes share the same ingredient, so both are 100% covered and
    // ordering falls through to cost, which is equal — assert coverage instead.
    expect(scored.every((r) => r.dealCoverage === 100)).toBe(true);

    // Now make one recipe uncoverable and confirm it sinks to the bottom.
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        name: "NoDeals",
        ingredients: [
          {
            name: "Enhjørning",
            quantity: "1 stk",
            searchTerms: ["enhjørning"],
            category: "meat",
          },
        ],
      }),
      beefRecipe({ name: "Covered" }),
    ]);
    const second = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    expect(second.scored.map((r) => r.name)).toEqual(["Covered", "NoDeals"]);
  });

  it("drops offers from non-preferred stores once preferences exist", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [makeOffer({ ...beefOffer, store: "Lidl" })]]]),
    );

    const { scored } = await scoreAllRecipes(new Set(["Netto"]), new Set(), 2, getLocale("DK"));
    expect(scored[0].ingredients[0].bestDeal).toBeNull();
    expect(scored[0].dealCoverage).toBe(0);
  });
});

describe("score_recipes tool", () => {
  it("is registered with when-to-use and when-not-to-use guidance", () => {
    const description = stub.tools.get("score_recipes")?.description ?? "";
    expect(description).toContain("USE WHEN");
    expect(description).toContain("NOT FOR");
    expect(description).toContain("matched-deal ingredient estimates");
    expect(description).toContain("not full recipe prices");
  });

  it("says there is nothing to score when the library is empty", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("# Recipe scores (0 recipes)");
    expect(text).toContain("No recipes to score. Add recipes first.");
  });

  it("renders cost, coverage, metadata, and the matched deal per recipe", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("# Recipe scores (1 recipes)");
    expect(text).toContain("## Bolognese");
    expect(text).toContain("medium | italian | beef | 4 servings");
    expect(text).toContain("Matched-deal ingredient estimate: 22.5 DKK");
    expect(text).toContain("Confirmed deal estimate: 22.5 DKK");
    expect(text).toContain("Uncertain-match estimate: 0 DKK");
    expect(text).toContain("Confirmed matches: 1");
    expect(text).toContain("Uncertain matches: 0");
    expect(text).toContain("Items without matched deal price: 0");
    expect(text).toContain("Confirmed deal coverage: 100%");
    expect(text).toContain("Candidate deal coverage: 100%");
    expect(text).toContain("Confirmed deals:");
    expect(text).not.toContain("Estimated total");
    expect(text).toContain("Hakket oksekød (500g): Hakket oksekød 8-12% — 23 DKK @ Netto");
  });

  it("passes household dealer IDs to retrieval and accepts foetex/Føtex by stable ID", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "foetex", dealerId: "bdf5A", priority: 1 }],
      }),
    );
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hakket oksekød", [beefOffer, { ...beefOffer, store: "Føtex", storeId: "bdf5A" }]],
      ]),
    );

    const text = textOf(await callTool(stub, "score_recipes", {}));
    const [, limit, , options] = vi.mocked(api.searchDealsBatch).mock.calls[0];

    expect(limit).toBe(8);
    expect(options?.dealerIds).toEqual(new Set(["bdf5A"]));
    expect(text).toContain("Confirmed deal coverage: 100%");
    expect(text).toContain("@ Føtex");
  });

  it("rejects the same display name when the offer dealer ID is wrong", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "Føtex", dealerId: "bdf5A", priority: 1 }],
      }),
    );
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [{ ...beefOffer, store: "Føtex", storeId: "wrong-id" }]]]),
    );

    const text = textOf(await callTool(stub, "score_recipes", {}));

    expect(text).toContain("Confirmed deal coverage: 0%");
    expect(text).toContain("Candidate deal coverage: 0%");
    expect(text).toContain("Not matched: Hakket oksekød");
  });

  it("uses the household country's currency", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold({ country: "FI" }));
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("Matched-deal ingredient estimate: 22.5 EUR");
  });

  it("counts and lists items without a matched deal price", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("Items without matched deal price: 1");
    expect(text).toContain("Not matched: Hakket oksekød (500g)");
    expect(text).not.toContain("0-price");
  });

  it("separates uncertain matches and shows the runner-up candidates", async () => {
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
            makeOffer({ id: "m1", heading: "Øko mælk eller fløde", price: 12 }),
            makeOffer({
              id: "m2",
              heading: "Sød mælk eller kærnemælk",
              price: 14,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("⚠ Uncertain matches (verify these):");
    expect(text).toContain("[low confidence]");
    expect(text).toContain("Confirmed matches: 0");
    expect(text).toContain("Uncertain matches: 1");
    expect(text).toContain("Confirmed deal coverage: 0%");
    expect(text).toContain("Candidate deal coverage: 100%");
    expect(text).toContain("Other candidates:");
    expect(text).toContain("Sød mælk eller kærnemælk");
  });

  it("shows confirmed and uncertain estimates with distinct coverage", async () => {
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
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        ["hakket oksekød", [beefOffer]],
        ["mælk", [makeOffer({ id: "milk", heading: "Øko mælk eller fløde", price: 12 })]],
      ]),
    );

    const text = textOf(await callTool(stub, "score_recipes", {}));

    expect(text).toContain("Matched-deal ingredient estimate: 25.5 DKK");
    expect(text).toContain("Confirmed deal estimate: 22.5 DKK");
    expect(text).toContain("Uncertain-match estimate: 3 DKK");
    expect(text).toContain("Confirmed matches: 1");
    expect(text).toContain("Uncertain matches: 1");
    expect(text).toContain("Confirmed deal coverage: 50%");
    expect(text).toContain("Candidate deal coverage: 100%");
  });

  it("omits the plan section unless optimize is set", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef" }),
      beefRecipe({ name: "B", proteinType: "chicken" }),
    ]);
    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).not.toContain("Optimized");
  });

  it("appends a day-by-day plan when optimize is set and enough recipes exist", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef", cuisineType: "italian" }),
      beefRecipe({ name: "B", proteinType: "chicken", cuisineType: "asian" }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const text = textOf(await callTool(stub, "score_recipes", { optimize: true, days: 2 }));
    expect(text).toContain("# Optimized 2-day plan");
    expect(text).toContain("Matched-deal planning estimate (not a full basket total): ~");
    expect(text).toContain("Unique matched-deal items in planning estimate:");
    expect(text).not.toContain("Total basket:");
    expect(text).toContain("Day 1:");
    expect(text).toContain("Day 2:");
  });

  it("skips the plan when there are fewer recipes than days", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe({ name: "A" })]);
    const text = textOf(await callTool(stub, "score_recipes", { optimize: true, days: 3 }));
    expect(text).toContain("# Recipe scores (1 recipes)");
    expect(text).not.toContain("Optimized");
  });

  it("explains which knobs to relax when the constraints admit no plan", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef" }),
      beefRecipe({ name: "B", proteinType: "beef" }),
    ]);
    const text = textOf(
      await callTool(stub, "score_recipes", {
        optimize: true,
        days: 2,
        maxPerProtein: 1,
      }),
    );
    expect(text).toContain("# Optimized 2-day plan");
    expect(text).toContain("Could not find a valid combination with the variety constraints");
    expect(text).toContain("maxPerProtein");
  });

  it("honours dietary exclusions when optimising", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "Beefy", proteinType: "beef" }),
      beefRecipe({ name: "Chicken", proteinType: "chicken" }),
      beefRecipe({ name: "Veggie", proteinType: "vegetarian" }),
    ]);
    const text = textOf(
      await callTool(stub, "score_recipes", {
        optimize: true,
        days: 2,
        excludeProteins: ["beef"],
      }),
    );
    expect(text).toContain("# Optimized 2-day plan");
    const planSection = text.slice(text.indexOf("# Optimized"));
    expect(planSection).not.toContain("Beefy");
  });

  it("returns a structured error when the deal batch fails", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockRejectedValue(new Error("upstream 500"));
    const result = await callTool(stub, "score_recipes", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to score recipes: upstream 500");
  });

  it("rejects a non-numeric days argument", async () => {
    await expect(callTool(stub, "score_recipes", { days: "seven" })).rejects.toThrow();
  });
});
