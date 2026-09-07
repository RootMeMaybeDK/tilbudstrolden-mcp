import type { PlanAndShopResult } from "../services/planning-service.js";
import type { ScoringServiceResult, StructuredScoredRecipe } from "../services/scoring-service.js";
import type { StructuredShoppingList } from "../services/shopping-service.js";

/** Only reportable fields cross HTTP; internal Maps and locale matching configuration stay private. */
export function scoredRecipeDto(recipe: StructuredScoredRecipe) {
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

export function scoringDto(result: ScoringServiceResult) {
  return {
    householdSize: result.householdSize,
    country: result.country,
    currency: result.currency,
    pantry: result.pantry,
    scoredRecipes: result.scored.map(scoredRecipeDto),
  };
}

/** Preserve the service's quantity, purchase and expiry snapshot without recomputation. */
export function shoppingDto(result: StructuredShoppingList) {
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
    grandTotal: result.grandTotal,
  };
}

export function planningDto(result: PlanAndShopResult) {
  const base = {
    status: result.status,
    days: result.days,
    householdSize: result.householdSize,
    country: result.country,
    currency: result.currency,
    constraints: result.constraints,
    scoredRecipes: result.scoredRecipes.map(scoredRecipeDto),
  };
  if (result.status === "insufficient-recipes") {
    return { ...base, availableRecipeCount: result.availableRecipeCount };
  }
  if (result.status === "no-valid-plan") return base;
  return {
    ...base,
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
