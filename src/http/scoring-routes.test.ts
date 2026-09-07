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

describe("recipe scoring HTTP route", () => {
  useHttpDatastore();
  const request = (body: unknown = {}) =>
    createHttpApp().request(`${HTTP_BASE}/api/recipes/score`, jsonRequest(body));

  it("uses real scoring and returns ranked recipes and context without execution Maps", async () => {
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({
            name: "Unmatched",
            ingredients: [
              { name: "Unknown", quantity: "1 stk", searchTerms: ["unknown"], category: "other" },
            ],
          }),
          makeHttpRecipe(),
        ],
      }),
    );
    const batch = vi
      .spyOn(api, "searchDealsBatch")
      .mockResolvedValueOnce(new Map([["hakket oksekød", [makeHttpOffer()]]]));
    const res = await request();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "country",
      "currency",
      "householdSize",
      "pantry",
      "scoredRecipes",
    ]);
    expect(body).toMatchObject({ householdSize: 3, country: "DK", currency: "DKK", pantry: [] });
    expect(body.scoredRecipes.map((r: { name: string }) => r.name)).toEqual(["Chili", "Unmatched"]);
    expect(body.scoredRecipes[0]).toMatchObject({
      matchedDealEstimate: 30,
      priceSummary: {
        confirmedDealEstimate: 30,
        uncertainDealEstimate: 0,
        matchedDealEstimate: 30,
        currency: "DKK",
      },
      matchSummary: {
        confirmedMatchCount: 1,
        lowConfidenceMatchCount: 0,
        unmatchedItemCount: 0,
        confirmedCoveragePercent: 100,
      },
    });
    expect(body.scoredRecipes[0].ingredients[0]).toMatchObject({
      confidence: "high",
      matchedDealEstimate: 30,
      matchedDeal: { heading: "Hakket oksekød 8-12%", ingredientEstimate: 30, store: "Netto" },
    });
    expect(body.scoredRecipes[1].ingredients[0]).toMatchObject({
      confidence: "none",
      matchedDealEstimate: null,
      matchedDeal: null,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /dealMap|synonymMap|ingredientTags|##|estimatedCost|fullBasket/,
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][3]?.dealerIds).toEqual(new Set(["n1"]));
  });

  it("preserves the people override in the proportional estimate", async () => {
    vi.spyOn(api, "searchDealsBatch").mockResolvedValueOnce(
      new Map([["hakket oksekød", [makeHttpOffer()]]]),
    );
    const body = await (await request({ people: 2 })).json();
    expect(body.householdSize).toBe(2);
    expect(body.scoredRecipes[0].priceSummary.matchedDealEstimate).toBe(20);
    expect((await store.load()).household.defaultServings).toBe(3);
  });

  it("separates low-confidence and unmatched items from confirmed prices", async () => {
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({
            ingredients: [
              {
                name: "Hakket oksekød",
                quantity: "500 g",
                searchTerms: ["hakket oksekød"],
                category: "meat",
              },
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
            makeHttpOffer({
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
    const recipe = (await (await request()).json()).scoredRecipes[0];
    expect(recipe.matchSummary).toMatchObject({
      confirmedMatchCount: 1,
      lowConfidenceMatchCount: 1,
      unmatchedItemCount: 1,
    });
    expect(recipe.priceSummary).toMatchObject({
      confirmedDealEstimate: 30,
      uncertainDealEstimate: 4.5,
      matchedDealEstimate: 34.5,
    });
    expect(recipe.ingredients[1].confidence).toBe("low");
  });

  it("rejects invalid people before any deal fetch", async () => {
    const batch = vi.spyOn(api, "searchDealsBatch");
    expect((await request({ people: "3" })).status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
  });

  it("maps upstream errors without exposing upstream URLs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(api, "searchDealsBatch").mockRejectedValueOnce(
      new Error("https://private-upstream/error"),
    );
    const res = await request();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    });
  });

  it("maps busy store errors to 503", async () => {
    vi.spyOn(store, "getHousehold").mockRejectedValueOnce(new store.DatastoreBusyError());
    expect((await request()).status).toBe(503);
  });
});
