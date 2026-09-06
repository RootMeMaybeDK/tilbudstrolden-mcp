import type { Offer } from "../api.js";
import { internalDealCandidateLimit, searchDealsBatch } from "../api.js";
import { type DealExpiryStatus, getDealExpiry } from "../deal-expiry.js";
import { getLocale, type Locale } from "../locales.js";
import {
  aggregateQuantities,
  computeShoppingCost,
  computeShoppingCostFromTotal,
  type DealMatchConfidence,
  type DealMatchSummary,
  type DealSummaryItem,
  expandSearchTerms,
  findBestDeal,
  formatQuantity,
  normalizeQuantity,
  type PreferredStores,
  parseQuantity,
  preferredDealerIds,
  type ShoppingCost,
  type ShoppingPriceSummary,
  summarizeDealMatches,
  summarizeShoppingPrices,
} from "../scoring.js";
import * as store from "../store.js";

export interface ShoppingContribution {
  recipeName: string;
  /** Original recipe quantity before household scaling. */
  quantity: string;
  recipeServings: number;
  /** Scaled canonical amount, or null when the recipe quantity cannot be parsed. */
  scaledAmount: number | null;
  scaledUnit: string | null;
  displayQuantity: string;
}

export interface ShoppingQuantity {
  displayQuantity: string;
  /** Aggregated canonical quantity when every contribution has a compatible unit. */
  aggregated: { totalAmount: number; unit: string } | null;
  contributions: ShoppingContribution[];
}

export interface ShoppingDealCandidate {
  offer: Offer;
  score: number;
}

export interface StructuredShoppingItem {
  ingredientName: string;
  category: string;
  searchTerms: string[];
  fromRecipes: string[];
  quantity: ShoppingQuantity;
  confidence: DealMatchConfidence;
  selectedOffer: Offer | null;
  selectedMatchScore: number | null;
  candidates: ShoppingDealCandidate[];
  /** Expiry state resolved once when the shopping result is built. */
  expiryStatus: DealExpiryStatus | null;
  expiryDaysRemaining: number | null;
  /** Pack-aware calculation when recipe and retail units are compatible. */
  purchase: ShoppingCost | null;
  /** Null means no matched deal price; it never means a free item. */
  matchedPurchaseSubtotal: number | null;
}

export interface ShoppingStoreGroup {
  storeName: string;
  items: StructuredShoppingItem[];
}

export interface ExpiringDealWarning {
  type: "expiring-deal";
  ingredientName: string;
  offer: Offer;
  daysRemaining: number;
  expiryStatus: Exclude<DealExpiryStatus, "none">;
}

export interface UncertainMatchWarning {
  type: "uncertain-match";
  ingredientName: string;
  selectedOffer: Offer;
  alternatives: ShoppingDealCandidate[];
}

export type ShoppingWarning = ExpiringDealWarning | UncertainMatchWarning;

export interface StructuredShoppingList {
  status: "ready" | "nothing-to-buy";
  requestedRecipeNames: string[];
  selectedRecipes: store.Recipe[];
  unknownRecipeNames: string[];
  householdSize: number;
  pantryExclusionEnabled: boolean;
  pantry: string[];
  skippedPantryIngredients: string[];
  items: StructuredShoppingItem[];
  matchedItems: StructuredShoppingItem[];
  unmatchedItems: StructuredShoppingItem[];
  storeGroups: ShoppingStoreGroup[];
  warnings: ShoppingWarning[];
  matchSummary: DealMatchSummary;
  priceSummary: ShoppingPriceSummary;
  /** Legacy matched-deal purchase subtotal retained for existing callers. */
  grandTotal: number;
  locale: Locale;
}

export interface ShoppingRecipeResolutionFailure {
  status: "no-matching-recipes";
  requestedRecipeNames: string[];
  selectedRecipes: store.Recipe[];
  unknownRecipeNames: string[];
  availableRecipeNames: string[];
}

export type GenerateShoppingListResult = StructuredShoppingList | ShoppingRecipeResolutionFailure;

export interface BuildShoppingListFromRecipesOptions {
  selectedRecipes: store.Recipe[];
  householdSize: number;
  pantry: string[];
  excludePantry: boolean;
  preferredStores: PreferredStores;
  locale: Locale;
  existingDealMap?: Map<string, Offer[]>;
  requestedRecipeNames?: string[];
  unknownRecipeNames?: string[];
}

export interface GenerateShoppingListOptions {
  recipeNames: string[];
  people?: number;
  excludePantry?: boolean;
}

/** Ingredient data aggregated across multiple recipes. */
interface AggregatedIngredient {
  name: string;
  searchTerms: string[];
  category: string;
  contributions: Array<{
    quantity: string;
    recipeServings: number;
    recipeName: string;
  }>;
  fromRecipes: string[];
}

function mergeIntoExisting(
  existing: AggregatedIngredient,
  recipe: store.Recipe,
  ingredient: store.Ingredient,
): void {
  existing.fromRecipes.push(recipe.name);
  existing.contributions.push({
    quantity: ingredient.quantity,
    recipeServings: recipe.servings,
    recipeName: recipe.name,
  });
  for (const term of ingredient.searchTerms) {
    if (!existing.searchTerms.includes(term)) existing.searchTerms.push(term);
  }
}

function makeAggregated(recipe: store.Recipe, ingredient: store.Ingredient): AggregatedIngredient {
  return {
    name: ingredient.name,
    searchTerms: [...ingredient.searchTerms],
    category: ingredient.category,
    contributions: [
      {
        quantity: ingredient.quantity,
        recipeServings: recipe.servings,
        recipeName: recipe.name,
      },
    ],
    fromRecipes: [recipe.name],
  };
}

/** Collect and aggregate ingredients across recipes, skipping pantry items. */
function collectIngredients(
  selectedRecipes: store.Recipe[],
  pantrySet: Set<string>,
): Map<string, AggregatedIngredient> {
  const allIngredients = new Map<string, AggregatedIngredient>();
  for (const recipe of selectedRecipes) {
    for (const ingredient of recipe.ingredients) {
      const key = ingredient.name.toLowerCase();
      if (pantrySet.has(key)) continue;
      const existing = allIngredients.get(key);
      if (existing) mergeIntoExisting(existing, recipe, ingredient);
      else allIngredients.set(key, makeAggregated(recipe, ingredient));
    }
  }
  return allIngredients;
}

function buildQuantity(ingredient: AggregatedIngredient, householdSize: number): ShoppingQuantity {
  const aggregated = aggregateQuantities(ingredient.contributions, householdSize);
  const contributions = ingredient.contributions.map((contribution): ShoppingContribution => {
    const parsed = parseQuantity(contribution.quantity);
    if (!parsed) {
      return {
        ...contribution,
        scaledAmount: null,
        scaledUnit: null,
        displayQuantity: contribution.quantity,
      };
    }
    const scale = contribution.recipeServings > 0 ? householdSize / contribution.recipeServings : 1;
    const rawScaledAmount = parsed.amount * scale;
    const scaledAmount = normalizeQuantity(rawScaledAmount);
    return {
      ...contribution,
      scaledAmount,
      scaledUnit: parsed.unit,
      // Keep legacy formatter threshold behavior while exposing a normalized numeric value.
      displayQuantity: formatQuantity(rawScaledAmount, parsed.unit),
    };
  });

  let displayQuantity: string;
  if (ingredient.contributions.length > 1 && aggregated) {
    displayQuantity = `${contributions.map((item) => item.displayQuantity).join(" + ")} = ${formatQuantity(aggregated.totalAmount, aggregated.unit)}`;
  } else if (aggregated) {
    displayQuantity = formatQuantity(aggregated.totalAmount, aggregated.unit);
  } else {
    displayQuantity = contributions.map((item) => item.displayQuantity).join(" + ");
  }

  return { displayQuantity, aggregated, contributions };
}

async function resolveDealMap(
  existingDealMap: Map<string, Offer[]> | undefined,
  ingredients: Map<string, AggregatedIngredient>,
  locale: Locale,
  preferredStores: PreferredStores,
): Promise<Map<string, Offer[]>> {
  if (existingDealMap !== undefined) return existingDealMap;
  const allSearchTerms = new Set<string>();
  for (const [, ingredient] of ingredients) {
    for (const term of expandSearchTerms(ingredient.searchTerms, locale.synonymMap)) {
      allSearchTerms.add(term);
    }
  }
  const dealerIds = preferredDealerIds(preferredStores);
  return searchDealsBatch(
    [...allSearchTerms],
    internalDealCandidateLimit(dealerIds),
    locale.country,
    { dealerIds },
  );
}

interface ShoppingContext {
  dealMap: Map<string, Offer[]>;
  preferredStores: PreferredStores;
  locale: Locale;
  householdSize: number;
}

function processIngredient(
  ingredient: AggregatedIngredient,
  context: ShoppingContext,
): StructuredShoppingItem {
  const result = findBestDeal(ingredient, context.dealMap, context.preferredStores, context.locale);
  const quantity = buildQuantity(ingredient, context.householdSize);

  if (!result.best) {
    return {
      ingredientName: ingredient.name,
      category: ingredient.category,
      searchTerms: [...ingredient.searchTerms],
      fromRecipes: [...ingredient.fromRecipes],
      quantity,
      confidence: "none",
      selectedOffer: null,
      selectedMatchScore: null,
      candidates: [],
      expiryStatus: null,
      expiryDaysRemaining: null,
      purchase: null,
      matchedPurchaseSubtotal: null,
    };
  }

  let purchase = quantity.aggregated
    ? computeShoppingCostFromTotal(
        result.best,
        quantity.aggregated.totalAmount,
        quantity.aggregated.unit,
      )
    : null;
  if (!purchase && ingredient.contributions.length === 1) {
    purchase = computeShoppingCost(
      result.best,
      ingredient.contributions[0].quantity,
      ingredient.contributions[0].recipeServings,
      context.householdSize,
    );
  }

  const expiry = getDealExpiry(result.best.validUntil);
  return {
    ingredientName: ingredient.name,
    category: ingredient.category,
    searchTerms: [...ingredient.searchTerms],
    fromRecipes: [...ingredient.fromRecipes],
    quantity,
    confidence: result.confidence,
    selectedOffer: result.best,
    selectedMatchScore: result.bestScore,
    candidates: result.candidates,
    expiryStatus: expiry.status,
    expiryDaysRemaining: expiry.daysRemaining,
    purchase,
    matchedPurchaseSubtotal: purchase?.totalCost ?? result.best.price ?? 0,
  };
}

function findSkippedPantry(pantry: string[], recipes: store.Recipe[]): string[] {
  return pantry.filter((item) =>
    recipes.some((recipe) =>
      recipe.ingredients.some((ingredient) => ingredient.name.toLowerCase() === item.toLowerCase()),
    ),
  );
}

function buildWarnings(items: StructuredShoppingItem[]): ShoppingWarning[] {
  const warnings: ShoppingWarning[] = [];
  for (const item of items) {
    const offer = item.selectedOffer;
    if (!offer) continue;

    const { expiryStatus, expiryDaysRemaining } = item;
    if (expiryStatus !== null && expiryStatus !== "none" && expiryDaysRemaining !== null) {
      warnings.push({
        type: "expiring-deal",
        ingredientName: item.ingredientName,
        offer,
        daysRemaining: expiryDaysRemaining,
        expiryStatus,
      });
    }

    if (item.confidence === "low" && item.candidates.length > 1) {
      warnings.push({
        type: "uncertain-match",
        ingredientName: item.ingredientName,
        selectedOffer: offer,
        alternatives: item.candidates.slice(1),
      });
    }
  }
  return warnings;
}

function groupByStore(items: StructuredShoppingItem[]): ShoppingStoreGroup[] {
  const groups = new Map<string, ShoppingStoreGroup>();
  for (const item of items) {
    const storeName = item.selectedOffer?.store;
    if (!storeName) continue;
    const group = groups.get(storeName) ?? { storeName, items: [] };
    group.items.push(item);
    groups.set(storeName, group);
  }
  return [...groups.values()];
}

function emptyStructuredResult(
  options: BuildShoppingListFromRecipesOptions,
): StructuredShoppingList {
  const summaryItems: DealSummaryItem[] = [];
  return {
    status: "nothing-to-buy",
    requestedRecipeNames:
      options.requestedRecipeNames ?? options.selectedRecipes.map((recipe) => recipe.name),
    selectedRecipes: options.selectedRecipes,
    unknownRecipeNames: options.unknownRecipeNames ?? [],
    householdSize: options.householdSize,
    pantryExclusionEnabled: options.excludePantry,
    pantry: options.pantry,
    skippedPantryIngredients: options.excludePantry
      ? findSkippedPantry(options.pantry, options.selectedRecipes)
      : [],
    items: [],
    matchedItems: [],
    unmatchedItems: [],
    storeGroups: [],
    warnings: [],
    matchSummary: summarizeDealMatches(summaryItems),
    priceSummary: summarizeShoppingPrices(summaryItems, options.locale.currency),
    grandTotal: 0,
    locale: options.locale,
  };
}

/** Build structured shopping data from explicit recipes and runtime context. */
export async function buildShoppingListFromRecipes(
  options: BuildShoppingListFromRecipesOptions,
): Promise<StructuredShoppingList> {
  const pantrySet = new Set(
    (options.excludePantry ? options.pantry : []).map((item) => item.toLowerCase()),
  );
  const ingredients = collectIngredients(options.selectedRecipes, pantrySet);
  if (ingredients.size === 0) return emptyStructuredResult(options);

  const dealMap = await resolveDealMap(
    options.existingDealMap,
    ingredients,
    options.locale,
    options.preferredStores,
  );
  const items = [...ingredients.values()].map((ingredient) =>
    processIngredient(ingredient, {
      dealMap,
      preferredStores: options.preferredStores,
      locale: options.locale,
      householdSize: options.householdSize,
    }),
  );
  const matchedItems = items.filter((item) => item.selectedOffer !== null);
  const unmatchedItems = items.filter((item) => item.selectedOffer === null);
  const summaryItems = items.map((item) => ({
    confidence: item.confidence,
    amount: item.matchedPurchaseSubtotal ?? 0,
  }));
  const grandTotal = items.reduce((total, item) => total + (item.matchedPurchaseSubtotal ?? 0), 0);

  return {
    status: "ready",
    requestedRecipeNames:
      options.requestedRecipeNames ?? options.selectedRecipes.map((recipe) => recipe.name),
    selectedRecipes: options.selectedRecipes,
    unknownRecipeNames: options.unknownRecipeNames ?? [],
    householdSize: options.householdSize,
    pantryExclusionEnabled: options.excludePantry,
    pantry: options.pantry,
    skippedPantryIngredients: options.excludePantry
      ? findSkippedPantry(options.pantry, options.selectedRecipes)
      : [],
    items,
    matchedItems,
    unmatchedItems,
    storeGroups: groupByStore(items),
    warnings: buildWarnings(items),
    matchSummary: summarizeDealMatches(summaryItems),
    priceSummary: summarizeShoppingPrices(summaryItems, options.locale.currency),
    grandTotal,
    locale: options.locale,
  };
}

/** Preserve the selected-recipe runtime read order used by existing shopping callers. */
export async function buildShoppingListForRecipes(
  selectedRecipes: store.Recipe[],
  householdSize: number,
  existingDealMap?: Map<string, Offer[]>,
  excludePantry = true,
): Promise<StructuredShoppingList> {
  const pantry = excludePantry ? await store.getPantry() : [];
  const household = await store.getHousehold();
  const locale = getLocale(household.country);
  return buildShoppingListFromRecipes({
    selectedRecipes,
    householdSize,
    pantry,
    excludePantry,
    preferredStores: household.stores,
    locale,
    existingDealMap,
  });
}

function resolveRecipeNames(allRecipes: store.Recipe[], requestedNames: string[]): store.Recipe[] {
  return allRecipes.filter((recipe) =>
    requestedNames.some((name) => recipe.name.toLowerCase() === name.toLowerCase()),
  );
}

function unknownRecipeNames(allRecipes: store.Recipe[], requestedNames: string[]): string[] {
  return requestedNames.filter(
    (name) => !allRecipes.some((recipe) => recipe.name.toLowerCase() === name.toLowerCase()),
  );
}

/** Resolve requested recipes and load runtime context in the legacy MCP read order. */
export async function generateShoppingList(
  options: GenerateShoppingListOptions,
): Promise<GenerateShoppingListResult> {
  const excludePantry = options.excludePantry ?? true;
  const allRecipes = await store.getRecipes();
  const selectedRecipes = resolveRecipeNames(allRecipes, options.recipeNames);
  const unknownNames = unknownRecipeNames(allRecipes, options.recipeNames);

  if (selectedRecipes.length === 0) {
    return {
      status: "no-matching-recipes",
      requestedRecipeNames: options.recipeNames,
      selectedRecipes,
      unknownRecipeNames: unknownNames,
      availableRecipeNames: allRecipes.map((recipe) => recipe.name),
    };
  }

  const sizingHousehold = await store.getHousehold();
  const householdSize =
    options.people ?? (sizingHousehold.people.length || sizingHousehold.defaultServings);
  const pantry = excludePantry ? await store.getPantry() : [];
  const matchingHousehold = await store.getHousehold();
  const locale = getLocale(matchingHousehold.country);

  return buildShoppingListFromRecipes({
    selectedRecipes,
    householdSize,
    pantry,
    excludePantry,
    preferredStores: matchingHousehold.stores,
    locale,
    requestedRecipeNames: options.recipeNames,
    unknownRecipeNames: unknownNames,
  });
}
