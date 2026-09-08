/** JSON wire contracts only. Keep this module independent of server/runtime modules. */
export type HttpErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "INVALID_COUNTRY"
  | "FORBIDDEN_ORIGIN"
  | "NOT_FOUND"
  | "RECIPE_NOT_FOUND"
  | "NO_MATCHING_RECIPES"
  | "INSUFFICIENT_RECIPES"
  | "NO_VALID_PLAN"
  | "DATASTORE_BUSY"
  | "INTERNAL_ERROR";

export type ErrorHttpResponse = { error: { code: HttpErrorCode; message: string } };
export type HealthHttpResponse = { status: "ok"; service: "tilbudstrolden" };

export type HouseholdHttpResponse = {
  people: {
    name: string;
    dietaryRestrictions: string[];
    defaultSchedule: Record<string, boolean>;
  }[];
  stores: { name: string; dealerId: string; priority: number }[];
  defaultServings: number;
  country: string;
};
export type PantryHttpResponse = { items: string[] };

export type RecipeHttpDto = {
  name: string;
  ingredients: { name: string; quantity: string; searchTerms: string[]; category: string }[];
  servings: number;
  complexity: "quick" | "medium" | "slow";
  cuisineType: string;
  proteinType: string;
};
export type RecipesHttpResponse = { recipes: RecipeHttpDto[] };
export type SaveRecipeHttpResponse = { status: "saved"; recipe: RecipeHttpDto };
export type RemoveRecipeHttpResponse = { status: "removed"; requestedName: string };

/** Full selected/candidate offer; price is the sticker price, not an ingredient estimate. */
export type OfferHttpDto = {
  id: string;
  heading: string;
  description: string | null;
  price: number | null;
  prePrice: number | null;
  currency: string;
  quantity: number | null;
  unit: string | null;
  pricePerUnit: string | null;
  store: string;
  storeId: string;
  validFrom: string;
  validUntil: string;
  imageUrl: string | null;
};
export type StoresHttpResponse = {
  country: string;
  source: "known-stores";
  /** Curated aliases may share the same stable dealer ID. */
  knownStores: Record<string, string>;
};
export type DealSearchHttpResponse = {
  query: string;
  country: string;
  currency: string;
  offers: OfferHttpDto[];
};
export type StoreOffersHttpResponse = { dealerId: string; offers: OfferHttpDto[] };

export type DealConfidenceHttp = "high" | "low" | "none";
export type DealMatchSummaryHttp = {
  eligibleItemCount: number;
  confirmedMatchCount: number;
  lowConfidenceMatchCount: number;
  unmatchedItemCount: number;
  confirmedCoveragePercent: number;
  candidateCoveragePercent: number;
};
/** Proportional matched-deal estimates, never full recipe prices. */
export type RecipeDealPriceSummaryHttp = {
  confirmedDealEstimate: number;
  uncertainDealEstimate: number;
  matchedDealEstimate: number;
  currency: string;
};
export type ScoredRecipeHttpDto = {
  name: string;
  servings: number;
  complexity: string;
  proteinType: string;
  cuisineType: string;
  matchedDealEstimate: number;
  matchSummary: DealMatchSummaryHttp;
  priceSummary: RecipeDealPriceSummaryHttp;
  ingredients: {
    name: string;
    /** Original recipe quantity, not the shopping requirement. */
    quantity: string;
    category: string;
    confidence: DealConfidenceHttp;
    matchedDealEstimate: number | null;
    /** Reduced service projection: no stable offer/dealer identity is available here. */
    matchedDeal: { heading: string; store: string; ingredientEstimate: number } | null;
    candidates: { heading: string; offerPrice: number; store: string; score: number }[];
  }[];
};
export type RecipeScoringHttpResponse = {
  householdSize: number;
  country: string;
  currency: string;
  pantry: string[];
  scoredRecipes: ScoredRecipeHttpDto[];
};

export type ShoppingQuantityHttp = {
  displayQuantity: string;
  aggregated: { totalAmount: number; unit: string } | null;
  contributions: {
    recipeName: string;
    quantity: string;
    recipeServings: number;
    scaledAmount: number | null;
    scaledUnit: string | null;
    displayQuantity: string;
  }[];
};
/** Pack-aware cost for a matched item only, not a full basket total. */
export type MatchedDealPurchaseHttp = {
  quantityNeeded: number;
  unitNeeded: string;
  packSize: number;
  packsNeeded: number;
  pricePerPack: number;
  totalCost: number;
  leftover: number;
  unitPrice: string | null;
};
export type DealExpiryStatusHttp = "none" | "expired" | "expires-today" | "expires-tomorrow";
export type ShoppingDealCandidateHttp = { offer: OfferHttpDto; score: number };
export type ShoppingItemHttp = {
  ingredientName: string;
  category: string;
  searchTerms: string[];
  fromRecipes: string[];
  quantity: ShoppingQuantityHttp;
  confidence: DealConfidenceHttp;
  selectedOffer: OfferHttpDto | null;
  selectedMatchScore: number | null;
  candidates: ShoppingDealCandidateHttp[];
  expiryStatus: DealExpiryStatusHttp | null;
  expiryDaysRemaining: number | null;
  purchase: MatchedDealPurchaseHttp | null;
  /** Null means unknown/unmatched, not a free item. */
  matchedPurchaseSubtotal: number | null;
};
export type ShoppingStoreGroupHttp = {
  /** Display grouping only; inspect selectedOffer.storeId for stable item identity. */
  storeName: string;
  items: ShoppingItemHttp[];
};
export type ShoppingWarningHttp =
  | {
      type: "expiring-deal";
      ingredientName: string;
      offer: OfferHttpDto;
      daysRemaining: number;
      expiryStatus: Exclude<DealExpiryStatusHttp, "none">;
    }
  | {
      type: "uncertain-match";
      ingredientName: string;
      selectedOffer: OfferHttpDto;
      alternatives: ShoppingDealCandidateHttp[];
    };
export type ShoppingDealPriceSummaryHttp = {
  confirmedPurchaseSubtotal: number;
  uncertainPurchaseSubtotal: number;
  /** Authoritative currency-rounded GUI subtotal; excludes unknown prices. */
  matchedPurchaseSubtotal: number;
  currency: string;
};
export type ShoppingHttpResponse = {
  status: "ready" | "nothing-to-buy";
  requestedRecipeNames: string[];
  selectedRecipes: RecipeHttpDto[];
  unknownRecipeNames: string[];
  householdSize: number;
  country: string;
  currency: string;
  pantryExclusionEnabled: boolean;
  pantry: string[];
  skippedPantryIngredients: string[];
  items: ShoppingItemHttp[];
  matchedItems: ShoppingItemHttp[];
  unmatchedItems: ShoppingItemHttp[];
  storeGroups: ShoppingStoreGroupHttp[];
  warnings: ShoppingWarningHttp[];
  matchSummary: DealMatchSummaryHttp;
  priceSummary: ShoppingDealPriceSummaryHttp;
};
export type ShoppingHttpErrorResponse = ErrorHttpResponse & {
  result: {
    status: "no-matching-recipes";
    requestedRecipeNames: string[];
    selectedRecipes: RecipeHttpDto[];
    unknownRecipeNames: string[];
    availableRecipeNames: string[];
  };
};

export type PlanningConstraintsHttp = {
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  excludeProteins?: string[];
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
};
type PlanningHttpContext = {
  days: number;
  householdSize: number;
  country: string;
  currency: string;
  constraints: PlanningConstraintsHttp;
  scoredRecipes: ScoredRecipeHttpDto[];
};
export type SuccessfulPlanAndShopHttpResponse = PlanningHttpContext & {
  status: "ok";
  plan: {
    day: number;
    recipeName: string;
    recipe: ScoredRecipeHttpDto;
    matchedDealEstimate: number;
  }[];
  selectedRecipes: RecipeHttpDto[];
  planningEstimate: {
    matchedDealPlanningEstimate: number;
    sharedMatchedDealEstimateSavings: number;
    uniqueMatchedDealIngredientCount: number;
  };
  shopping: ShoppingHttpResponse;
};
export type InsufficientRecipesHttpResult = PlanningHttpContext & {
  status: "insufficient-recipes";
  availableRecipeCount: number;
};
export type NoValidPlanHttpResult = PlanningHttpContext & { status: "no-valid-plan" };
/** Success body, or the nested `result` in a 422 computation error. */
export type PlanAndShopHttpResponse =
  | SuccessfulPlanAndShopHttpResponse
  | InsufficientRecipesHttpResult
  | NoValidPlanHttpResult;
export type PlanAndShopHttpErrorResponse = ErrorHttpResponse & {
  result: InsufficientRecipesHttpResult | NoValidPlanHttpResult;
};

export type MealEntryHttp = { date: string; recipe: string; people: string[] };
export type RecordMealHttpResponse = { status: "logged"; entry: MealEntryHttp };
export type MealHistoryHttpResponse = { weeks: number; entries: MealEntryHttp[] };
export type SpendEntryHttp = {
  date: string;
  store: string;
  /** User-recorded amount, unrelated to computed matched-deal prices. */
  estimatedTotal: number;
  items: number;
  notes: string;
};
export type RecordSpendHttpResponse = {
  status: "logged";
  entry: SpendEntryHttp;
  currency: string;
  currencySymbol: string;
};
export type SpendHistoryHttpResponse =
  | { status: "empty"; weeks: number; entries: SpendEntryHttp[] }
  | {
      status: "ready";
      weeks: number;
      entries: SpendEntryHttp[];
      total: number;
      /** Non-finite service averages (e.g. weeks=0) become JSON null. */
      averagePerWeek: number | null;
      currency: string;
      currencySymbol: string;
    };
