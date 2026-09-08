import type { Hono } from "hono";
import { z } from "zod";
import type { HouseholdHttpResponse, PantryHttpResponse } from "../contracts/http.js";
import { updateHouseholdSettings } from "../services/household-service.js";
import { updatePantryItems } from "../services/pantry-service.js";
import { getHousehold, getPantry } from "../store.js";
import { errorBody, parseJsonBody } from "./errors.js";

const householdPatch = z.object({
  country: z.string().optional(),
  people: z
    .array(
      z.object({
        name: z.string(),
        dietaryRestrictions: z.array(z.string()),
        defaultSchedule: z.record(z.string(), z.boolean()),
      }),
    )
    .optional(),
  stores: z
    .array(
      z.object({
        name: z.string(),
        dealerId: z.string(),
        priority: z.number(),
      }),
    )
    .optional(),
  defaultServings: z.number().optional(),
});

const pantryPatch = z.object({
  add: z.array(z.string()).optional().default([]),
  remove: z.array(z.string()).optional().default([]),
});

export function registerHouseholdRoutes(app: Hono): void {
  app.get("/api/household", async (c) =>
    c.json((await getHousehold()) satisfies HouseholdHttpResponse),
  );
  app.patch("/api/household", async (c) => {
    const result = await updateHouseholdSettings(await parseJsonBody(c, householdPatch));
    if (result.status === "invalid-country") {
      return c.json(
        errorBody(
          "INVALID_COUNTRY",
          `Supported countries: ${result.supportedCountries.join(", ")}.`,
        ),
        400,
      );
    }
    return c.json(result.household satisfies HouseholdHttpResponse);
  });
  app.get("/api/pantry", async (c) =>
    c.json({ items: await getPantry() } satisfies PantryHttpResponse),
  );
  app.patch("/api/pantry", async (c) => {
    const result = await updatePantryItems(await parseJsonBody(c, pantryPatch));
    return c.json({ items: result.pantry } satisfies PantryHttpResponse);
  });
}
