import type { Hono } from "hono";
import { z } from "zod";
import type {
  MealHistoryHttpResponse,
  RecordMealHttpResponse,
  RecordSpendHttpResponse,
} from "../contracts/http.js";
import {
  readMealHistory,
  readSpendHistory,
  recordMeal,
  recordSpend,
} from "../services/tracking-service.js";
import { spendHistoryDto } from "./dto.js";
import { errorBody, parseJsonBody } from "./errors.js";

const lookback = z.coerce.number().optional();
const mealInput = z.object({ date: z.string(), recipe: z.string(), people: z.array(z.string()) });
const spendInput = z.object({
  date: z.string(),
  store: z.string(),
  estimatedTotal: z.number(),
  items: z.number(),
  notes: z.string().optional().default(""),
});

export function registerTrackingRoutes(app: Hono): void {
  app.get("/api/meal-history", async (c) => {
    const parsed = lookback.safeParse(c.req.query("weeks"));
    if (!parsed.success)
      return c.json(errorBody("INVALID_REQUEST", "weeks must be a number."), 400);
    return c.json((await readMealHistory(parsed.data)) satisfies MealHistoryHttpResponse);
  });
  app.post("/api/meals", async (c) =>
    c.json((await recordMeal(await parseJsonBody(c, mealInput))) satisfies RecordMealHttpResponse),
  );
  app.get("/api/spend-log", async (c) => {
    const parsed = lookback.safeParse(c.req.query("weeks"));
    if (!parsed.success)
      return c.json(errorBody("INVALID_REQUEST", "weeks must be a number."), 400);
    return c.json(spendHistoryDto(await readSpendHistory(parsed.data)));
  });
  app.post("/api/spend", async (c) =>
    c.json(
      (await recordSpend(await parseJsonBody(c, spendInput))) satisfies RecordSpendHttpResponse,
    ),
  );
}
