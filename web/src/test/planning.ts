import type {
  DealMatchSummaryHttp,
  ScoredRecipeHttpDto,
  SuccessfulPlanAndShopHttpResponse,
} from "../../../src/contracts/http";

// Synthetic wire fixtures only. No production services or authoritative datastore.
export const matchSummary: DealMatchSummaryHttp = {
  eligibleItemCount: 3,
  confirmedMatchCount: 1,
  lowConfidenceMatchCount: 1,
  unmatchedItemCount: 1,
  confirmedCoveragePercent: 33,
  candidateCoveragePercent: 67,
};

function recipe(name: string, amount: number): ScoredRecipeHttpDto {
  return {
    name,
    servings: 4,
    complexity: "quick",
    proteinType: "vegetarian",
    cuisineType: "danish",
    matchedDealEstimate: amount,
    matchSummary,
    priceSummary: {
      confirmedDealEstimate: amount - 1,
      uncertainDealEstimate: 1,
      matchedDealEstimate: amount,
      currency: "DKK",
    },
    ingredients: [
      {
        name: "Confirmed ingredient",
        quantity: "1 stk",
        category: "produce",
        confidence: "high",
        matchedDealEstimate: amount - 1,
        matchedDeal: {
          heading: "Confirmed product",
          store: "Test store",
          ingredientEstimate: amount - 1,
        },
        candidates: [],
      },
      {
        name: "Uncertain ingredient",
        quantity: "1 stk",
        category: "produce",
        confidence: "low",
        matchedDealEstimate: 1,
        matchedDeal: { heading: "Uncertain product", store: "Test store", ingredientEstimate: 1 },
        candidates: [],
      },
      {
        name: "Unpriced ingredient",
        quantity: "1 stk",
        category: "produce",
        confidence: "none",
        matchedDealEstimate: null,
        matchedDeal: null,
        candidates: [],
      },
    ],
  };
}

export function makePlan(): SuccessfulPlanAndShopHttpResponse {
  const first = recipe("Zeta-ret", 34);
  const second = recipe("Alfa-ret", 11);
  return {
    status: "ok",
    days: 2,
    householdSize: 3,
    country: "DK",
    currency: "DKK",
    constraints: { maxPerProtein: 2, maxPerCuisine: 2, maxSlowDays: 2 },
    scoredRecipes: [second, first],
    selectedRecipes: [],
    plan: [
      { day: 1, recipeName: first.name, recipe: first, matchedDealEstimate: 34 },
      { day: 2, recipeName: second.name, recipe: second, matchedDealEstimate: 11 },
    ],
    planningEstimate: {
      matchedDealPlanningEstimate: 41.5,
      sharedMatchedDealEstimateSavings: 3.5,
      uniqueMatchedDealIngredientCount: 4,
    },
    shopping: {
      status: "ready",
      requestedRecipeNames: [first.name, second.name],
      selectedRecipes: [],
      unknownRecipeNames: [],
      householdSize: 3,
      country: "DK",
      currency: "DKK",
      pantryExclusionEnabled: true,
      pantry: [],
      skippedPantryIngredients: [],
      items: [],
      matchedItems: [],
      unmatchedItems: [],
      storeGroups: [{ storeName: "Shopping-only store", items: [] }],
      warnings: [],
      matchSummary,
      priceSummary: {
        confirmedPurchaseSubtotal: 120,
        uncertainPurchaseSubtotal: 3.45,
        matchedPurchaseSubtotal: 123.45,
        currency: "DKK",
      },
    },
  };
}
