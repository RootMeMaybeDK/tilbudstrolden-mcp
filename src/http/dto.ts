import type {
  PlanAndShopHttpResponse,
  RecipeScoringHttpResponse,
  ScoredRecipeHttpDto,
  ShoppingHttpResponse,
  SpendHistoryHttpResponse,
} from "../contracts/http.js";
import type { PlanAndShopResult } from "../services/planning-service.js";
import type { ScoringServiceResult, StructuredScoredRecipe } from "../services/scoring-service.js";
import type { StructuredShoppingList } from "../services/shopping-service.js";
import type { readSpendHistory } from "../services/tracking-service.js";

/** Only reportable fields cross HTTP; internal Maps and locale matching configuration stay private. */
export function scoredRecipeDto(recipe: StructuredScoredRecipe): ScoredRecipeHttpDto {
  return {
    name: recipe.name,
    servings: recipe.servings,
    complexity: recipe.complexity,
    proteinType: recipe.proteinType,
    cuisineType: recipe.cuisineType,
    matchedDealEstimate: recipe.estimatedCost,
    matchSummary: recipe.matchSummary,
    priceSummary: recipe.priceSummary,
    ingredients: recipe.ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      category: ingredient.category,
      confidence: ingredient.confidence,
      matchedDealEstimate: ingredient.bestDeal ? ingredient.estimatedCost : null,
      matchedDeal: ingredient.bestDeal
        ? {
            heading: ingredient.bestDeal.heading,
            store: ingredient.bestDeal.store,
            ingredientEstimate: ingredient.bestDeal.price,
          }
        : null,
      candidates:
        ingredient.candidates?.map((candidate) => ({
          heading: candidate.heading,
          offerPrice: candidate.price,
          store: candidate.store,
          score: candidate.score,
        })) ?? [],
    })),
  };
}

export function scoringDto(result: ScoringServiceResult): RecipeScoringHttpResponse {
  return {
    householdSize: result.householdSize,
    country: result.country,
    currency: result.currency,
    pantry: result.pantry,
    scoredRecipes: result.scored.map(scoredRecipeDto),
  };
}

/** Preserve the service's quantity, purchase and expiry snapshot without recomputation. */
export function shoppingDto(result: StructuredShoppingList): ShoppingHttpResponse {
  return {
    status: result.status,
    requestedRecipeNames: result.requestedRecipeNames,
    selectedRecipes: result.selectedRecipes,
    unknownRecipeNames: result.unknownRecipeNames,
    householdSize: result.householdSize,
    country: result.locale.country,
    currency: result.locale.currency,
    pantryExclusionEnabled: result.pantryExclusionEnabled,
    pantry: result.pantry,
    skippedPantryIngredients: result.skippedPantryIngredients,
    items: result.items,
    matchedItems: result.matchedItems,
    unmatchedItems: result.unmatchedItems,
    storeGroups: result.storeGroups,
    warnings: result.warnings,
    matchSummary: result.matchSummary,
    priceSummary: result.priceSummary,
  };
}

export function planningDto(result: PlanAndShopResult): PlanAndShopHttpResponse {
  const base = {
    days: result.days,
    householdSize: result.householdSize,
    country: result.country,
    currency: result.currency,
    constraints: result.constraints,
    scoredRecipes: result.scoredRecipes.map(scoredRecipeDto),
  };
  if (result.status === "insufficient-recipes") {
    return { ...base, status: result.status, availableRecipeCount: result.availableRecipeCount };
  }
  if (result.status === "no-valid-plan") return { ...base, status: result.status };
  return {
    ...base,
    status: result.status,
    plan: result.plan.map((day) => ({
      day: day.day,
      recipeName: day.recipeName,
      recipe: scoredRecipeDto(day.recipe),
      matchedDealEstimate: day.matchedDealEstimate,
    })),
    selectedRecipes: result.selectedRecipes,
    planningEstimate: result.planningEstimate,
    shopping: shoppingDto(result.shopping),
  };
}

/** Mirror JSON's non-finite-number handling without changing service calculations. */
export function spendHistoryDto(
  result: Awaited<ReturnType<typeof readSpendHistory>>,
): SpendHistoryHttpResponse {
  if (result.status === "empty") {
    return { status: result.status, weeks: result.weeks, entries: result.entries };
  }
  return {
    status: result.status,
    weeks: result.weeks,
    entries: result.entries,
    total: result.total,
    averagePerWeek: Number.isFinite(result.averagePerWeek) ? result.averagePerWeek : null,
    currency: result.currency,
    currencySymbol: result.currencySymbol,
  };
}
