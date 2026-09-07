import type { Hono } from "hono";
import { z } from "zod";
import { planAndShop } from "../services/planning-service.js";
import { planningDto } from "./dto.js";
import { errorBody, parseJsonBody } from "./errors.js";

const planningInput = z.object({
  days: z.number().optional().default(7),
  people: z.number().optional(),
  maxPerProtein: z.number().optional().default(2),
  maxPerCuisine: z.number().optional().default(2),
  maxSlowDays: z.number().optional().default(2),
  excludeProteins: z.array(z.string()).optional(),
  slowOnlyOnDays: z.array(z.number()).optional(),
  preferCuisines: z.record(z.string(), z.number()).optional(),
});

export function registerPlanningRoutes(app: Hono): void {
  app.post("/api/plan-and-shop", async (c) => {
    const result = await planAndShop(await parseJsonBody(c, planningInput));
    const dto = planningDto(result);
    if (result.status === "insufficient-recipes") {
      return c.json(
        {
          ...errorBody("INSUFFICIENT_RECIPES", "Not enough recipes for the requested days."),
          result: dto,
        },
        422,
      );
    }
    if (result.status === "no-valid-plan") {
      return c.json(
        {
          ...errorBody("NO_VALID_PLAN", "No plan satisfies the requested constraints."),
          result: dto,
        },
        422,
      );
    }
    return c.json(dto);
  });
}
