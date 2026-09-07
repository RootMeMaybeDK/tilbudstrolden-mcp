import type { ScoringServiceResult, StructuredScoredRecipe } from "../services/scoring-service.js";

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
