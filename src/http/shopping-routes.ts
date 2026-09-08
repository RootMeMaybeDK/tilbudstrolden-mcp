import type { Hono } from "hono";
import { z } from "zod";
import type { ShoppingHttpErrorResponse } from "../contracts/http.js";
import { generateShoppingList } from "../services/shopping-service.js";
import { shoppingDto } from "./dto.js";
import { errorBody, parseJsonBody } from "./errors.js";

const shoppingInput = z.object({
  recipeNames: z.array(z.string()),
  people: z.number().optional(),
  excludePantry: z.boolean().optional(),
});

export function registerShoppingRoutes(app: Hono): void {
  app.post("/api/shopping-list", async (c) => {
    const result = await generateShoppingList(await parseJsonBody(c, shoppingInput));
    if (result.status === "no-matching-recipes") {
      return c.json(
        {
          ...errorBody("NO_MATCHING_RECIPES", "No requested recipes were found."),
          result,
        } satisfies ShoppingHttpErrorResponse,
        422,
      );
    }
    return c.json(shoppingDto(result));
  });
}
