import * as store from "../store.js";

export interface RecipeIngredientInput {
  name: string;
  quantity: string;
  searchTerms?: string[];
  category?: string;
}

export interface SaveRecipeInput {
  name: string;
  servings?: number;
  complexity: "quick" | "medium" | "slow";
  cuisineType: string;
  proteinType: string;
  ingredients: RecipeIngredientInput[];
}

export interface SaveRecipeResult {
  status: "saved";
  recipe: store.Recipe;
}

export type RemoveRecipeResult =
  | { status: "removed"; requestedName: string }
  | { status: "not-found"; requestedName: string };

/** Normalize recipe input and delegate the authoritative upsert to the store. */
export async function saveRecipe(input: SaveRecipeInput): Promise<SaveRecipeResult> {
  const recipe: store.Recipe = {
    name: input.name,
    servings: input.servings ?? 4,
    complexity: input.complexity,
    cuisineType: input.cuisineType,
    proteinType: input.proteinType,
    ingredients: input.ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      searchTerms:
        ingredient.searchTerms && ingredient.searchTerms.length > 0
          ? ingredient.searchTerms
          : [ingredient.name.toLowerCase()],
      category: ingredient.category || "other",
    })),
  };

  await store.addRecipe(recipe);
  return { status: "saved", recipe };
}

/** Delegate removal to the store and map its boolean result to a domain outcome. */
export async function removeRecipeByName(name: string): Promise<RemoveRecipeResult> {
  const removed = await store.removeRecipe(name);
  return { status: removed ? "removed" : "not-found", requestedName: name };
}
