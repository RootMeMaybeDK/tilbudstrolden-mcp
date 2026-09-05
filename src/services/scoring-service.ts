import type { Offer } from "../api.js";
import { internalDealCandidateLimit, searchDealsBatch } from "../api.js";
import { getLocale, type Locale } from "../locales.js";
import {
  computeIngredientCost,
  type DealCandidate,
  type DealMatchSummary,
  expandSearchTerms,
  findBestDeal,
  type PreferredStores,
  preferredDealerIds,
  type RecipePriceSummary,
  type ScoredIngredient,
  type ScoredRecipe,
  summarizeDealMatches,
  summarizeRecipePrices,
} from "../scoring.js";
import * as store from "../store.js";

export type StructuredScoredRecipe = ScoredRecipe & {
  matchSummary: DealMatchSummary;
  priceSummary: RecipePriceSummary;
};

export interface ScoreRecipeLibraryOptions {
  recipes: store.Recipe[];
  preferredStores: PreferredStores;
  pantrySet: Set<string>;
  householdSize: number;
  locale?: Locale;
}

export interface ScoreResult {
  scored: StructuredScoredRecipe[];
  /** Internal execution context for reuse by planning/shopping; not an HTTP DTO. */
  dealMap: Map<string, Offer[]>;
}

export interface ScoreRecipesOptions {
  people?: number;
}

export interface ScoringServiceResult extends ScoreResult {
  householdSize: number;
  country: string;
  currency: string;
  pantry: string[];
  locale: Locale;
}

/** Everything a recipe needs to be scored against the current deal map. */
interface ScoringContext {
  dealMap: Map<string, Offer[]>;
  preferredStores: PreferredStores;
  pantrySet: Set<string>;
  householdSize: number;
  locale?: Locale;
}

/** Map the low-confidence alternatives onto the reportable candidate shape. */
function toDealCandidates(result: ReturnType<typeof findBestDeal>): DealCandidate[] | undefined {
  if (result.confidence !== "low") return undefined;
  return result.candidates.map((candidate) => ({
    heading: candidate.offer.heading,
    price: candidate.offer.price ?? 0,
    store: candidate.offer.store,
    score: candidate.score,
  }));
}

function scoreOneIngredient(
  ingredient: store.Ingredient,
  servings: number,
  context: ScoringContext,
): ScoredIngredient {
  const result = findBestDeal(ingredient, context.dealMap, context.preferredStores, context.locale);
  const cost = result.best
    ? computeIngredientCost(result.best, ingredient.quantity, servings, context.householdSize)
    : 0;

  return {
    name: ingredient.name,
    quantity: ingredient.quantity,
    category: ingredient.category,
    bestDeal: result.best
      ? {
          heading: result.best.heading,
          price: cost,
          store: result.best.store,
        }
      : null,
    estimatedCost: cost,
    confidence: result.confidence,
    candidates: toDealCandidates(result),
  };
}

function scoreOneRecipe(recipe: store.Recipe, context: ScoringContext): StructuredScoredRecipe {
  let totalCost = 0;
  let withDeals = 0;
  let nonPantryCount = 0;
  const ingredients: ScoredIngredient[] = [];

  for (const ingredient of recipe.ingredients) {
    if (context.pantrySet.has(ingredient.name.toLowerCase())) continue;
    nonPantryCount++;

    const scoredIngredient = scoreOneIngredient(ingredient, recipe.servings, context);
    ingredients.push(scoredIngredient);
    if (scoredIngredient.bestDeal) {
      totalCost += scoredIngredient.estimatedCost;
      withDeals++;
    }
  }

  const summaryItems = ingredients.map((ingredient) => ({
    confidence: ingredient.confidence,
    amount: ingredient.estimatedCost,
  }));
  const matchSummary = summarizeDealMatches(summaryItems);
  const priceSummary = summarizeRecipePrices(summaryItems, context.locale?.currency ?? "DKK");
  const estimatedCost = Math.round(totalCost * 100) / 100;
  const dealCoverage = nonPantryCount > 0 ? Math.round((withDeals / nonPantryCount) * 100) : 100;

  return {
    name: recipe.name,
    servings: recipe.servings,
    complexity: recipe.complexity,
    proteinType: recipe.proteinType,
    cuisineType: recipe.cuisineType,
    // Legacy fields intentionally retain their existing numerical semantics.
    estimatedCost,
    dealCoverage,
    ingredients,
    matchSummary,
    priceSummary,
  };
}

/** Every unique, synonym-expanded search term across all non-pantry ingredients. */
function collectSearchTerms(
  recipes: store.Recipe[],
  pantrySet: Set<string>,
  locale?: Locale,
): Set<string> {
  const allTerms = new Set<string>();
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      if (pantrySet.has(ingredient.name.toLowerCase())) continue;
      for (const term of expandSearchTerms(ingredient.searchTerms, locale?.synonymMap)) {
        allTerms.add(term);
      }
    }
  }
  return allTerms;
}

/** Score an explicit recipe library without hidden datastore reads. */
export async function scoreRecipeLibrary(options: ScoreRecipeLibraryOptions): Promise<ScoreResult> {
  const { recipes, preferredStores, pantrySet, householdSize, locale } = options;
  if (recipes.length === 0) return { scored: [], dealMap: new Map() };

  // Batch fetch all deals in parallel.
  const allTerms = collectSearchTerms(recipes, pantrySet, locale);
  const countryId = locale?.country ?? "DK";
  const dealerIds = preferredDealerIds(preferredStores);
  const dealMap = await searchDealsBatch(
    [...allTerms],
    internalDealCandidateLimit(dealerIds),
    countryId,
    { dealerIds },
  );

  const scored = recipes.map((recipe) =>
    scoreOneRecipe(recipe, { dealMap, preferredStores, pantrySet, householdSize, locale }),
  );

  scored.sort((a, b) => {
    // Primary: higher deal coverage is better.
    if (b.dealCoverage !== a.dealCoverage) return b.dealCoverage - a.dealCoverage;
    // Secondary: lower cost is better.
    return a.estimatedCost - b.estimatedCost;
  });

  return { scored, dealMap };
}

/** Preserve the existing scoring entrypoint while moving it out of the MCP tool module. */
export async function scoreAllRecipes(
  preferredStores: PreferredStores,
  pantrySet: Set<string>,
  householdSize: number,
  locale?: Locale,
): Promise<ScoreResult> {
  const recipes = await store.getRecipes();
  return scoreRecipeLibrary({ recipes, preferredStores, pantrySet, householdSize, locale });
}

/** Load runtime scoring context in the existing household → pantry → recipes order. */
export async function scoreRecipes(
  options: ScoreRecipesOptions = {},
): Promise<ScoringServiceResult> {
  const household = await store.getHousehold();
  const locale = getLocale(household.country);
  const pantry = await store.getPantry();
  const pantrySet = new Set(pantry.map((item) => item.toLowerCase()));
  const householdSize = options.people ?? (household.people.length || household.defaultServings);
  const result = await scoreAllRecipes(household.stores, pantrySet, householdSize, locale);

  return {
    ...result,
    householdSize,
    country: locale.country,
    currency: locale.currency,
    pantry,
    locale,
  };
}
