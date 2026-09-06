import { calculateBasketCost, findOptimalWeek, type VarietyConstraints } from "../scoring.js";
import * as store from "../store.js";
import { type StructuredScoredRecipe, scoreRecipes } from "./scoring-service.js";
import { buildShoppingListForRecipes, type StructuredShoppingList } from "./shopping-service.js";

export interface PlanningConstraints {
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  excludeProteins?: string[];
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
}

export interface PlanAndShopOptions extends PlanningConstraints {
  days: number;
  people?: number;
}

export interface PlannedDay {
  day: number;
  recipeName: string;
  recipe: StructuredScoredRecipe;
  matchedDealEstimate: number;
}

export interface PlanningEstimate {
  matchedDealPlanningEstimate: number;
  sharedMatchedDealEstimateSavings: number;
  uniqueMatchedDealIngredientCount: number;
}

interface PlanningResultBase {
  days: number;
  householdSize: number;
  country: string;
  currency: string;
  constraints: PlanningConstraints;
  scoredRecipes: StructuredScoredRecipe[];
}

export interface SuccessfulPlanAndShopResult extends PlanningResultBase {
  status: "ok";
  plan: PlannedDay[];
  selectedRecipes: store.Recipe[];
  planningEstimate: PlanningEstimate;
  shopping: StructuredShoppingList;
}

export interface InsufficientRecipesResult extends PlanningResultBase {
  status: "insufficient-recipes";
  availableRecipeCount: number;
}

export interface NoValidPlanResult extends PlanningResultBase {
  status: "no-valid-plan";
}

export type PlanAndShopResult =
  | SuccessfulPlanAndShopResult
  | InsufficientRecipesResult
  | NoValidPlanResult;

function planningConstraints(options: PlanAndShopOptions): PlanningConstraints {
  return {
    maxPerProtein: options.maxPerProtein,
    maxPerCuisine: options.maxPerCuisine,
    maxSlowDays: options.maxSlowDays,
    excludeProteins: options.excludeProteins,
    slowOnlyOnDays: options.slowOnlyOnDays,
    preferCuisines: options.preferCuisines,
  };
}

/** Score, optimize, map recipes, and build structured shopping data for one plan. */
export async function planAndShop(options: PlanAndShopOptions): Promise<PlanAndShopResult> {
  const scoring = await scoreRecipes({ people: options.people });
  const constraints = planningConstraints(options);
  const baseResult = {
    days: options.days,
    householdSize: scoring.householdSize,
    country: scoring.country,
    currency: scoring.currency,
    constraints,
    scoredRecipes: scoring.scored,
  };

  if (scoring.scored.length < options.days) {
    return {
      ...baseResult,
      status: "insufficient-recipes",
      availableRecipeCount: scoring.scored.length,
    };
  }

  const optimizerConstraints: VarietyConstraints = {
    ...constraints,
    ingredientTags: scoring.locale.ingredientTags,
  };
  const optimized = findOptimalWeek(scoring.scored, options.days, optimizerConstraints);
  if (!optimized) return { ...baseResult, status: "no-valid-plan" };

  // The optimizer returns references from the structured scoring result.
  const plannedRecipes = optimized.recipes as StructuredScoredRecipe[];
  const basket = calculateBasketCost(plannedRecipes);
  const plan = plannedRecipes.map(
    (recipe, index): PlannedDay => ({
      day: index + 1,
      recipeName: recipe.name,
      recipe,
      matchedDealEstimate: recipe.estimatedCost,
    }),
  );

  const recipeLibrary = await store.getRecipes();
  // Preserve legacy shopping order: recipe-library order, not planned-day order.
  const selectedRecipes = recipeLibrary.filter((recipe) =>
    plannedRecipes.some((planned) => planned.name.toLowerCase() === recipe.name.toLowerCase()),
  );
  const shopping = await buildShoppingListForRecipes(
    selectedRecipes,
    scoring.householdSize,
    scoring.dealMap,
  );

  return {
    ...baseResult,
    status: "ok",
    plan,
    selectedRecipes,
    planningEstimate: {
      matchedDealPlanningEstimate: basket.totalCost,
      sharedMatchedDealEstimateSavings: basket.sharedSavings,
      uniqueMatchedDealIngredientCount: basket.uniqueIngredients,
    },
    shopping,
  };
}
