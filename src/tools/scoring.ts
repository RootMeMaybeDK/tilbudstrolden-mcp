import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Locale } from "../locales.js";
import {
  calculateBasketCost,
  type DealCandidate,
  findOptimalWeek,
  type ScoredIngredient,
  type ScoredRecipe,
  summarizeDealMatches,
  summarizeRecipePrices,
} from "../scoring.js";
import { scoreRecipes } from "../services/scoring-service.js";
import { errorResult } from "./shared.js";

function formatRecipeHeader(r: ScoredRecipe, currency: string): string[] {
  const summaryItems = r.ingredients.map((ingredient) => ({
    confidence: ingredient.confidence,
    amount: ingredient.estimatedCost,
  }));
  const matchSummary = r.matchSummary ?? summarizeDealMatches(summaryItems);
  const priceSummary = r.priceSummary ?? summarizeRecipePrices(summaryItems, currency);
  return [
    `## ${r.name}`,
    `   ${r.complexity} | ${r.cuisineType} | ${r.proteinType} | ${r.servings} servings`,
    `   Matched-deal ingredient estimate: ${priceSummary.matchedDealEstimate} ${currency} (not a full recipe price)`,
    `   Confirmed deal estimate: ${priceSummary.confirmedDealEstimate} ${currency}`,
    `   Uncertain-match estimate: ${priceSummary.uncertainDealEstimate} ${currency}`,
    `   Confirmed matches: ${matchSummary.confirmedMatchCount}`,
    `   Uncertain matches: ${matchSummary.lowConfidenceMatchCount}`,
    `   Items without matched deal price: ${matchSummary.unmatchedItemCount}`,
    `   Confirmed deal coverage: ${matchSummary.confirmedCoveragePercent}%`,
    `   Candidate deal coverage: ${matchSummary.candidateCoveragePercent}%`,
  ];
}

function formatHighConfDeals(ingredients: ScoredIngredient[], currency: string): string[] {
  if (ingredients.length === 0) return [];
  const lines = [`   Confirmed deals:`];
  for (const i of ingredients) {
    const deal = i.bestDeal;
    if (!deal) continue;
    lines.push(
      `     ${i.name} (${i.quantity}): ${deal.heading} — ${Math.round(deal.price)} ${currency} @ ${deal.store}`,
    );
  }
  return lines;
}

function formatLowConfCandidates(candidates: DealCandidate[], currency: string): string[] {
  const lines = [`       Other candidates:`];
  for (const c of candidates.slice(1)) {
    lines.push(`         - ${c.heading} — ${c.price} ${currency} @ ${c.store} (score: ${c.score})`);
  }
  return lines;
}

function formatLowConfDeal(i: ScoredIngredient, currency: string): string[] {
  const deal = i.bestDeal;
  if (!deal) return [];
  const lines = [
    `     ${i.name} (${i.quantity}): ${deal.heading} — ${Math.round(deal.price)} ${currency} @ ${deal.store} [low confidence]`,
  ];
  if (i.candidates && i.candidates.length > 1) {
    lines.push(...formatLowConfCandidates(i.candidates, currency));
  }
  return lines;
}

function formatLowConfDeals(ingredients: ScoredIngredient[], currency: string): string[] {
  if (ingredients.length === 0) return [];
  const lines = [`   ⚠ Uncertain matches (verify these):`];
  for (const i of ingredients) {
    lines.push(...formatLowConfDeal(i, currency));
  }
  return lines;
}

function formatNoDealItems(ingredients: ScoredIngredient[]): string[] {
  if (ingredients.length === 0) return [];
  return [`   Not matched: ${ingredients.map((i) => `${i.name} (${i.quantity})`).join(", ")}`];
}

function formatRecipeScore(r: ScoredRecipe, currency = "DKK"): string[] {
  const high = r.ingredients.filter((i) => i.confidence === "high");
  const low = r.ingredients.filter((i) => i.confidence === "low");
  const none = r.ingredients.filter((i) => i.confidence === "none");

  return [
    ...formatRecipeHeader(r, currency),
    ...formatHighConfDeals(high, currency),
    ...formatLowConfDeals(low, currency),
    ...formatNoDealItems(none),
    "",
  ];
}

function formatScoredRecipes(scored: ScoredRecipe[], currency = "DKK"): string {
  if (scored.length === 0) return "No recipes to score. Add recipes first.";

  const lines: string[] = [];
  for (const r of scored) {
    lines.push(...formatRecipeScore(r, currency));
  }
  return lines.join("\n");
}

interface ScoreRecipesArgs {
  optimize: boolean;
  days: number;
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  excludeProteins?: string[];
  allowProteinOnDays?: Record<string, number[]>;
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
}

/** Render the optimized day-by-day plan, or an explanation of why none was found */
function formatOptimizedPlan(
  scored: ScoredRecipe[],
  args: ScoreRecipesArgs,
  locale: Locale,
): string[] {
  const { days } = args;
  const cur = locale.currency;
  const bestPlan = findOptimalWeek(scored, days, {
    maxPerProtein: args.maxPerProtein,
    maxPerCuisine: args.maxPerCuisine,
    maxSlowDays: args.maxSlowDays,
    excludeProteins: args.excludeProteins,
    allowProteinOnDays: args.allowProteinOnDays,
    slowOnlyOnDays: args.slowOnlyOnDays,
    preferCuisines: args.preferCuisines,
    ingredientTags: locale.ingredientTags,
  });

  if (!bestPlan) {
    return [
      "Could not find a valid combination with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
    ];
  }

  const basket = calculateBasketCost(bestPlan.recipes);
  const lines = [
    `Matched-deal planning estimate (not a full basket total): ~${basket.totalCost} ${cur} for ${days} days`,
  ];
  if (basket.sharedSavings > 0) {
    lines.push(`Shared matched-deal estimate savings: ~${basket.sharedSavings} ${cur}`);
  }
  lines.push(`Unique matched-deal items in planning estimate: ${basket.uniqueIngredients}\n`);
  for (let i = 0; i < bestPlan.recipes.length; i++) {
    const r = bestPlan.recipes[i];
    lines.push(
      `Day ${i + 1}: ${r.name} (matched-deal estimate: ~${r.estimatedCost} ${cur}) [${r.proteinType}, ${r.cuisineType}, ${r.complexity}]`,
    );
  }
  return lines;
}

async function handleScoreRecipes(args: ScoreRecipesArgs) {
  try {
    const { scored, locale } = await scoreRecipes();

    const parts = [
      `# Recipe scores (${scored.length} recipes)\n`,
      formatScoredRecipes(scored, locale.currency),
    ];

    if (args.optimize && scored.length >= args.days) {
      parts.push(`\n# Optimized ${args.days}-day plan\n`);
      parts.push(...formatOptimizedPlan(scored, args, locale));
    }

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  } catch (err) {
    return errorResult(`Failed to score recipes: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerScoringTools(server: McpServer): void {
  server.tool(
    "score_recipes",
    "Score all saved recipes against current deals, optionally optimize a weekly meal plan. USE WHEN: deciding what to cook based on current deals, comparing matched-deal ingredient estimates. NOT FOR: generating a shopping list (use generate_shopping_list or plan_and_shop). Shows confirmed and uncertain matches, items without a matched deal price, and confirmed/candidate deal coverage. Estimates are not full recipe prices.",
    {
      optimize: z.boolean().optional().default(false).describe("Also generate optimal weekly plan"),
      days: z.number().optional().default(7).describe("Days to plan (default 7)"),
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
      maxSlowDays: z
        .number()
        .optional()
        .default(2)
        .describe("Max slow-cook days in plan (default 2)"),
      excludeProteins: z
        .array(z.string())
        .optional()
        .describe(
          'Dietary exclusions. Checks both recipe type and individual ingredients. E.g. ["pork"] also catches bacon in vegetarian recipes. Options: pork, beef, lamb, fish, shellfish, dairy, gluten, beans, nuts, egg',
        ),
      allowProteinOnDays: z
        .record(z.string(), z.array(z.number()))
        .optional()
        .describe(
          'Per-day exceptions for excluded proteins (1-indexed). E.g. {"pork": [2]} = allow pork on day 2 (Tuesday)',
        ),
      slowOnlyOnDays: z
        .array(z.number())
        .optional()
        .describe("Restrict slow recipes to these days only (1-indexed). E.g. [6, 7] for weekends"),
      preferCuisines: z
        .record(z.string(), z.number())
        .optional()
        .describe(
          'Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes. Best-effort, won\'t fail if impossible.',
        ),
    },
    handleScoreRecipes,
  );
}
