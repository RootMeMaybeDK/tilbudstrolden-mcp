import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { planAndShop, type SuccessfulPlanAndShopResult } from "../services/planning-service.js";
import { generateShoppingList } from "../services/shopping-service.js";
import { errorResult } from "./shared.js";
import { formatShoppingList } from "./shopping-list.js";

interface ShoppingListArgs {
  recipes: string[];
  people?: number;
  excludePantry: boolean;
}

async function handleGenerateShoppingList({ recipes, people, excludePantry }: ShoppingListArgs) {
  try {
    const result = await generateShoppingList({
      recipeNames: recipes,
      people,
      excludePantry,
    });

    if (result.status === "no-matching-recipes") {
      const available = result.availableRecipeNames.join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `No matching recipes found. Available: ${available || "none (add recipes first)"}`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: formatShoppingList(result) }],
    };
  } catch (err) {
    return errorResult(
      `Failed to generate shopping list: ${err instanceof Error ? err.message : err}`,
    );
  }
}

interface PlanArgs {
  days: number;
  people?: number;
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  excludeProteins?: string[];
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
}

/** Render the day-by-day plan header, matched-deal planning estimate, and one line per day */
function formatMealPlan(result: SuccessfulPlanAndShopResult): string[] {
  const parts: string[] = [`# ${result.days}-day meal plan (${result.householdSize} people)\n`];

  parts.push(
    `Matched-deal planning estimate (not a full basket total): ~${result.planningEstimate.matchedDealPlanningEstimate} ${result.currency}`,
  );
  if (result.planningEstimate.sharedMatchedDealEstimateSavings > 0) {
    parts.push(
      `Shared matched-deal estimate savings: ~${result.planningEstimate.sharedMatchedDealEstimateSavings} ${result.currency}`,
    );
  }
  parts.push("");

  for (const day of result.plan) {
    const recipe = day.recipe;
    parts.push(
      `Day ${day.day}: ${day.recipeName} (matched-deal estimate: ~${day.matchedDealEstimate} ${result.currency}) [${recipe.proteinType}, ${recipe.cuisineType}, ${recipe.complexity}]`,
    );
  }

  return parts;
}

async function handlePlanAndShop(args: PlanArgs) {
  try {
    const result = await planAndShop(args);

    if (result.status === "insufficient-recipes") {
      return errorResult(
        `Need at least ${result.days} recipes to plan ${result.days} days, but only ${result.availableRecipeCount} recipes exist. Add more with add_recipe.`,
      );
    }

    if (result.status === "no-valid-plan") {
      return errorResult(
        "Could not find a valid meal plan with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
      );
    }

    const parts = formatMealPlan(result);

    parts.push("\n---\n");
    parts.push(formatShoppingList(result.shopping));

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  } catch (err) {
    return errorResult(`Failed to plan: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerShoppingTools(server: McpServer): void {
  server.tool(
    "generate_shopping_list",
    "Deal-optimized shopping list from specific recipes, grouped by store. USE WHEN: preparing to shop for chosen recipes ('shopping list for Bolognese and Chili'). Aggregates quantities, computes pack sizes, and reports confirmed/uncertain matched-deal purchase subtotals plus items without a matched deal price. NOT FOR: deciding what to cook (use score_recipes or plan_and_shop first). The subtotal is not a full basket total. Requires recipes to exist (see add_recipe).",
    {
      recipes: z.array(z.string()).describe("Recipe names"),
      people: z.number().optional().describe("Household size (overrides stored household config)"),
      excludePantry: z
        .boolean()
        .optional()
        .default(true)
        .describe("Skip pantry items (default true)"),
    },
    handleGenerateShoppingList,
  );

  server.tool(
    "plan_and_shop",
    "Score recipes, optimize a weekly meal plan, and generate a shopping list in one step. USE WHEN: 'plan my week', 'what should we eat?', 'make a meal plan with shopping list'. This is the main entry point for weekly dinner planning. NOT FOR: shopping for specific pre-chosen recipes (use generate_shopping_list). Returns a day-by-day matched-deal planning estimate (not a full basket total), followed by a shopping list with matched-deal purchase subtotals grouped by store.",
    {
      days: z.number().optional().default(7).describe("Days to plan (default 7)"),
      people: z.number().optional().describe("Household size (overrides stored config)"),
      maxPerProtein: z
        .number()
        .optional()
        .default(2)
        .describe("Max same protein in plan (default 2)"),
      maxPerCuisine: z
        .number()
        .optional()
        .default(2)
        .describe("Max same cuisine in plan (default 2)"),
      maxSlowDays: z.number().optional().default(2).describe("Max slow-cook days (default 2)"),
      excludeProteins: z
        .array(z.string())
        .optional()
        .describe('Dietary exclusions, e.g. ["pork", "dairy"]. Also scans ingredient names.'),
      slowOnlyOnDays: z
        .array(z.number())
        .optional()
        .describe("Restrict slow recipes to these days (1-indexed). E.g. [6, 7]"),
      preferCuisines: z
        .record(z.string(), z.number())
        .optional()
        .describe('Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes'),
    },
    handlePlanAndShop,
  );
}
