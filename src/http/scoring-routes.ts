import type { Hono } from "hono";
import { z } from "zod";
import { scoreRecipes } from "../services/scoring-service.js";
import { scoringDto } from "./dto.js";
import { parseJsonBody } from "./errors.js";

const scoringInput = z.object({ people: z.number().optional() });

export function registerScoringRoutes(app: Hono): void {
  app.post("/api/recipes/score", async (c) => {
    const result = await scoreRecipes(await parseJsonBody(c, scoringInput));
    return c.json(scoringDto(result));
  });
}
