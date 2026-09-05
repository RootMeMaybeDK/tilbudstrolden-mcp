import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDealerCache, internalDealCandidateLimit, searchDealsBatch } from "./api.js";
import { getLocale } from "./locales.js";
import { preferredDealerIds } from "./scoring.js";
import type { Household, Recipe } from "./store.js";

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    getHousehold: vi.fn(),
    getPantry: vi.fn(),
    getRecipes: vi.fn(),
  };
});

const store = await import("./store.js");
const { scoreAllRecipes } = await import("./services/scoring-service.js");
const { buildShoppingList } = await import("./tools/shopping-list.js");

const household: Household = {
  people: [],
  stores: [
    { name: "rema 1000", dealerId: "11deC", priority: 1 },
    { name: "netto", dealerId: "9ba51", priority: 2 },
    { name: "foetex", dealerId: "bdf5A", priority: 3 },
    { name: "lidl", dealerId: "71c90", priority: 4 },
    { name: "365discount", dealerId: "DWZE1w", priority: 5 },
  ],
  defaultServings: 4,
  country: "DK",
};

function beefRecipe(name: string, cuisineType: string): Recipe {
  return {
    name,
    servings: 4,
    complexity: "medium",
    cuisineType,
    proteinType: "beef",
    ingredients: [
      {
        name: "Hakket oksekød",
        quantity: "500 g",
        searchTerms: ["hakket oksekød"],
        category: "meat",
      },
    ],
  };
}

const recipes = [
  beefRecipe("Chili con Carne", "mexican"),
  beefRecipe("Spaghetti Bolognese", "italian"),
];

function rawOffer(
  id: string,
  dealerId: string,
  storeName: string,
  heading = "Hakket oksekød 8-12%",
  price = 35,
) {
  return {
    id,
    heading,
    description: null,
    pricing: { price, pre_price: null, currency: "DKK" },
    quantity: {
      unit: { symbol: "g", si: { symbol: "g", factor: 1 } },
      size: { from: 500, to: 500 },
      pieces: { from: null, to: null },
    },
    branding: { name: storeName },
    dealer_id: dealerId,
    dealer: { name: storeName, country: { id: "DK" } },
    run_from: "2026-09-01",
    run_till: "2026-09-09",
    images: { view: null },
  };
}

function rawDealer(store: Household["stores"][number]) {
  return {
    id: store.dealerId,
    name: store.name,
    website: null,
    logo: null,
    country: { id: "DK" },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("preferred result outside the combined dealer candidate window", () => {
  let searchUrls: URL[];

  beforeEach(() => {
    clearDealerCache();
    searchUrls = [];
    vi.mocked(store.getHousehold).mockResolvedValue(household);
    vi.mocked(store.getPantry).mockResolvedValue([]);
    vi.mocked(store.getRecipes).mockResolvedValue(recipes);

    const precedingDealerIds = ["71c90", "11deC", "9ba51", "bdf5A"];
    const precedingOffers = Array.from({ length: 14 }, (_, index) =>
      rawOffer(
        `preceding-${index + 1}`,
        precedingDealerIds[index % precedingDealerIds.length],
        "Preferred Store",
        "Hakket okse- eller grise-/kalvekød",
        79,
      ),
    );
    const coop365 = rawOffer("coop-365", "DWZE1w", "365discount", "Coop hakket oksekød 8-12%");
    const rankedOffers = [...precedingOffers, coop365];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/dealers?")) {
          return jsonResponse(household.stores.map(rawDealer));
        }
        const searchUrl = new URL(url);
        searchUrls.push(searchUrl);
        const requestedLimit = Number(searchUrl.searchParams.get("limit"));
        return jsonResponse(rankedOffers.slice(0, requestedLimit));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDealerCache();
  });

  it("keeps result 15 available to batch, scoring, and shopping", async () => {
    const dealerIds = preferredDealerIds(household.stores);
    const candidateLimit = internalDealCandidateLimit(dealerIds);
    const dealMap = await searchDealsBatch(["hakket oksekød"], candidateLimit, "DK", {
      dealerIds,
    });
    const { scored } = await scoreAllRecipes(household.stores, new Set(), 4, getLocale("DK"));
    const shopping = await buildShoppingList(recipes, 4);

    expect(candidateLimit).toBe(40);
    expect(dealMap.get("hakket oksekød")?.map((offer) => offer.id)).toContain("coop-365");
    for (const recipe of ["Chili con Carne", "Spaghetti Bolognese"]) {
      const scoredRecipe = scored.find((entry) => entry.name === recipe);
      expect(scoredRecipe?.ingredients[0]).toMatchObject({
        confidence: "high",
        bestDeal: {
          heading: "Coop hakket oksekød 8-12%",
          store: "365discount",
        },
      });
    }
    expect(shopping).toContain("## 365discount (1 items)");
    expect(shopping).toContain("Coop hakket oksekød 8-12%");
    expect(shopping).not.toContain("Buy at regular price");

    expect(searchUrls).toHaveLength(3);
    for (const url of searchUrls) {
      expect(url.searchParams.getAll("dealer_ids")).toEqual(["11deC,9ba51,bdf5A,71c90,DWZE1w"]);
      expect(url.searchParams.get("limit")).toBe("40");
    }
  });
});
