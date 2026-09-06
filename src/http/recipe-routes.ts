import type { Hono } from "hono";
import { z } from "zod";
import { removeRecipeByName, saveRecipe } from "../services/recipe-service.js";
import { getRecipes } from "../store.js";
import { errorBody, parseJsonBody } from "./errors.js";

const recipeInput = z.object({
  name: z.string(),
  servings: z.number().optional(),
  complexity: z.enum(["quick", "medium", "slow"]),
  cuisineType: z.string(),
  proteinType: z.string(),
  ingredients: z.array(
    z.object({
      name: z.string(),
      quantity: z.string(),
      searchTerms: z.array(z.string()).optional(),
      category: z.string().optional(),
    }),
  ),
});

export function registerRecipeRoutes(app: Hono): void {
  app.get("/api/recipes", async (c) => c.json({ recipes: await getRecipes() }));
  app.post("/api/recipes", async (c) => {
    const result = await saveRecipe(await parseJsonBody(c, recipeInput));
    return c.json(result, 200);
  });
  app.delete("/api/recipes/:name", async (c) => {
    // Hono decodes the path parameter once; a second decode would corrupt literal percent sequences.
    const result = await removeRecipeByName(c.req.param("name"));
    if (result.status === "not-found") {
      return c.json(errorBody("RECIPE_NOT_FOUND", "Recipe not found."), 404);
    }
    return c.json(result);
  });
}
