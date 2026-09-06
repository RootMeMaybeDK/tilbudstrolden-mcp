import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SUPPORTED_COUNTRIES } from "../locales.js";
import { updateHouseholdSettings } from "../services/household-service.js";
import { updatePantryItems } from "../services/pantry-service.js";
import * as store from "../store.js";
import { errorResult } from "./shared.js";

const ONBOARDING_TEXT = `No household configured yet. Get started in 3 steps:

1. Set up people and stores: update_household (use list_stores to find dealer IDs)
2. Add pantry staples: update_pantry (salt, pepper, oil, etc.)
3. Add recipes: add_recipe (or use the built-in defaults)

Then run plan_and_shop to get a meal plan with shopping list!`;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatPerson(p: store.Person): string {
  const diet = p.dietaryRestrictions.length > 0 ? p.dietaryRestrictions.join(", ") : "none";
  const days = Object.entries(p.defaultSchedule)
    .filter(([, home]) => home)
    .map(([day]) => day)
    .join(", ");
  return `- ${p.name}: dietary: ${diet} | home: ${days || "all days"}`;
}

async function handleGetHousehold() {
  const household = await store.getHousehold();
  if (household.people.length === 0 && household.stores.length === 0) {
    return textResult(ONBOARDING_TEXT);
  }
  const people = household.people.map(formatPerson);
  const stores = household.stores
    .sort((a, b) => a.priority - b.priority)
    .map((s) => `- ${s.priority}. ${s.name} (${s.dealerId})`);
  return textResult(
    `Household (${household.country} market, default ${household.defaultServings} servings):\n\nPeople:\n${people.join("\n")}\n\nStores (by priority):\n${stores.join("\n")}`,
  );
}

interface UpdateHouseholdArgs {
  country?: string;
  people?: Array<{
    name: string;
    dietaryRestrictions: string[];
    defaultSchedule: Record<string, boolean>;
  }>;
  stores?: Array<{ name: string; dealerId: string; priority: number }>;
  defaultServings?: number;
}

async function handleUpdateHousehold(args: UpdateHouseholdArgs) {
  const result = await updateHouseholdSettings(args);
  if (result.status === "invalid-country") {
    return errorResult(
      `Invalid country code "${result.country}". Supported: ${result.supportedCountries.join(", ")}`,
    );
  }
  const { household } = result;
  return textResult(
    `Household updated: ${household.country} market, ${household.people.length} people, ${household.stores.length} stores, default ${household.defaultServings} servings.`,
  );
}

async function handleUpdatePantry({ add, remove }: { add: string[]; remove: string[] }) {
  const { pantry } = await updatePantryItems({ add, remove });
  return textResult(`Pantry (${pantry.length} items): ${pantry.join(", ") || "(empty)"}`);
}

async function handleGetPantry() {
  const pantry = await store.getPantry();
  return textResult(
    pantry.length > 0
      ? `Pantry (${pantry.length} items): ${pantry.join(", ")}`
      : "Pantry is empty. Use update_pantry to add staples (salt, pepper, oil, etc.) so they're excluded from shopping lists.",
  );
}

export function registerHouseholdTools(server: McpServer): void {
  server.tool(
    "get_household",
    "Get household config: people, dietary restrictions, preferred stores, servings. USE WHEN: checking current setup before meal planning, verifying store preferences. Returns onboarding guidance if not yet configured.",
    {},
    handleGetHousehold,
  );

  server.tool(
    "update_household",
    `Set household members, dietary restrictions, preferred stores, country, servings. USE WHEN: first-time setup or changing household config. Required before shopping lists can filter by preferred stores. TIP: use list_stores to find dealer IDs. Set country to change market: ${SUPPORTED_COUNTRIES.join(", ")}. Returns updated config summary: country, people count, store count, default servings.`,
    {
      country: z
        .string()
        .optional()
        .describe(
          `Country code: ${SUPPORTED_COUNTRIES.join(", ")}. Defaults to DK. Changes which stores and deals are shown.`,
        ),
      people: z
        .array(
          z.object({
            name: z.string().describe("Name"),
            dietaryRestrictions: z.array(z.string()).describe("e.g. 'no pork', 'lactose-free'"),
            defaultSchedule: z
              .record(z.string(), z.boolean())
              .describe("Days at home, e.g. {monday: true}. Omitted = true."),
          }),
        )
        .optional()
        .describe("People in household"),
      stores: z
        .array(
          z.object({
            name: z.string().describe("Store name"),
            dealerId: z.string().describe("Dealer ID from list_stores"),
            priority: z.number().describe("1 = closest/default"),
          }),
        )
        .optional()
        .describe("Preferred stores"),
      defaultServings: z.number().optional().describe("Default servings"),
    },
    handleUpdateHousehold,
  );

  server.tool(
    "update_pantry",
    "Add or remove pantry items (excluded from shopping lists). USE WHEN: updating stock after shopping or noting staples you always have. Items are matched case-insensitively. Returns updated pantry item list.",
    {
      add: z.array(z.string()).optional().default([]).describe("Items to add to pantry"),
      remove: z.array(z.string()).optional().default([]).describe("Items to remove from pantry"),
    },
    handleUpdatePantry,
  );

  server.tool(
    "get_pantry",
    "List pantry items (excluded from shopping lists). USE WHEN: checking what's already stocked before generating a shopping list. Returns list of pantry item names.",
    {},
    handleGetPantry,
  );
}
