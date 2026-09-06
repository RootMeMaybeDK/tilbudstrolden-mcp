import type { Offer } from "../api.js";
import { formatExpiryStatus } from "../deal-expiry.js";
import type { DealMatchSummary, ShoppingPriceSummary } from "../scoring.js";
import { formatQuantity } from "../scoring.js";
import {
  buildShoppingListForRecipes,
  type ExpiringDealWarning,
  type StructuredShoppingItem,
  type StructuredShoppingList,
  type UncertainMatchWarning,
} from "../services/shopping-service.js";
import type { Recipe } from "../store.js";

function formatMatchedItem(item: StructuredShoppingItem, currencySymbol: string): string {
  const offer = item.selectedOffer as Offer;
  const validTo = offer.validUntil?.slice(0, 10) ?? "unknown";
  const confidence = item.confidence === "low" ? " ⚠" : "";
  const expiry = item.expiryStatus ? formatExpiryStatus(item.expiryStatus) : "";
  const shopping = item.purchase;

  if (shopping) {
    const packInfo =
      shopping.packsNeeded > 1
        ? `${shopping.packsNeeded} x ${shopping.pricePerPack} ${currencySymbol}`
        : `${shopping.pricePerPack} ${currencySymbol}`;
    const leftoverInfo =
      shopping.leftover > 0
        ? ` (${formatQuantity(shopping.leftover, shopping.unitNeeded)} leftover)`
        : "";
    return `${item.ingredientName}: need ${item.quantity.displayQuantity} -> ${packInfo} = ${shopping.totalCost} ${currencySymbol} [${formatQuantity(shopping.packSize, shopping.unitNeeded)}/pack${shopping.unitPrice ? `, ${shopping.unitPrice}` : ""}]${leftoverInfo} -- ${offer.heading} @ ${offer.store} until ${validTo}${expiry}${confidence}`;
  }

  return `${item.ingredientName} (${item.quantity.displayQuantity}): ${offer.heading} - ${offer.price} ${offer.currency}${offer.pricePerUnit ? ` (${offer.pricePerUnit})` : ""} @ ${offer.store} until ${validTo}${expiry}${confidence}`;
}

function formatUnmatchedItem(item: StructuredShoppingItem): string {
  return `${item.ingredientName} (${item.quantity.displayQuantity}) [${item.fromRecipes.join(", ")}]`;
}

function formatUncertainWarning(warning: UncertainMatchWarning): string {
  const alternatives = warning.alternatives
    .map(
      (candidate) =>
        `${candidate.offer.heading} - ${candidate.offer.price} ${candidate.offer.currency} @ ${candidate.offer.store}`,
    )
    .join("; ");
  return `${warning.ingredientName}: picked "${warning.selectedOffer.heading}" but also found: ${alternatives}`;
}

function formatExpiringWarning(warning: ExpiringDealWarning): string {
  const validTo = warning.offer.validUntil?.slice(0, 10) ?? "unknown";
  return `${warning.ingredientName}: deal at ${warning.offer.store} ${formatExpiryStatus(warning.expiryStatus).trim().toLowerCase()} (${validTo})`;
}

function bulletSection(header: string, items: string[]): string[] {
  if (items.length === 0) return [];
  const lines = [header];
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
  return lines;
}

function storeSection(
  storeName: string,
  items: StructuredShoppingItem[],
  currencySymbol: string,
): string[] {
  const lines = [`## ${storeName} (${items.length} items)`];
  for (let index = 0; index < items.length; index++) {
    lines.push(`${index + 1}. ${formatMatchedItem(items[index], currencySymbol)}`);
  }
  lines.push("");
  return lines;
}

/** Format structured shopping data using the existing MCP text contract. */
export function formatShoppingList(result: StructuredShoppingList): string {
  if (result.status === "nothing-to-buy") {
    return "All ingredients are in your pantry. Nothing to buy!";
  }

  const parts: string[] = [
    `Shopping list for: ${result.selectedRecipes.map((recipe) => recipe.name).join(", ")} (${result.householdSize} people)`,
    `Matched-deal purchase subtotal: ${result.priceSummary.matchedPurchaseSubtotal} ${result.priceSummary.currency} (not a full basket total)`,
    `Confirmed deal subtotal: ${result.priceSummary.confirmedPurchaseSubtotal} ${result.priceSummary.currency}`,
    `Uncertain-match subtotal: ${result.priceSummary.uncertainPurchaseSubtotal} ${result.priceSummary.currency}`,
    `Confirmed matches: ${result.matchSummary.confirmedMatchCount}`,
    `Uncertain matches: ${result.matchSummary.lowConfidenceMatchCount}`,
    `Items without matched deal price: ${result.matchSummary.unmatchedItemCount}`,
    "",
  ];

  const expiringWarnings = result.warnings
    .filter((warning): warning is ExpiringDealWarning => warning.type === "expiring-deal")
    .map(formatExpiringWarning);
  parts.push(...bulletSection("## ⏰ Buy first (expiring soon)", expiringWarnings));

  for (const group of result.storeGroups) {
    parts.push(...storeSection(group.storeName, group.items, result.locale.currencySymbol));
  }

  parts.push(
    ...bulletSection(
      `## Buy at regular price (${result.unmatchedItems.length} items)`,
      result.unmatchedItems.map(formatUnmatchedItem),
    ),
  );

  const uncertainWarnings = result.warnings
    .filter((warning): warning is UncertainMatchWarning => warning.type === "uncertain-match")
    .map(formatUncertainWarning);
  parts.push(...bulletSection("## ⚠ Uncertain matches (verify these)", uncertainWarnings));

  if (result.skippedPantryIngredients.length > 0) {
    parts.push(`## Skipped (in pantry): ${result.skippedPantryIngredients.join(", ")}`);
  }

  return parts.join("\n");
}

/** Existing structured-plus-text compatibility contract for internal callers. */
export interface ShoppingListResult {
  text: string;
  matchSummary: DealMatchSummary;
  priceSummary: ShoppingPriceSummary;
  /** Legacy matched-deal purchase subtotal retained for existing callers. */
  grandTotal: number;
}

export async function buildShoppingListResult(
  selectedRecipes: Recipe[],
  householdSize: number,
  existingDealMap?: Map<string, Offer[]>,
  excludePantry = true,
): Promise<ShoppingListResult> {
  const result = await buildShoppingListForRecipes(
    selectedRecipes,
    householdSize,
    existingDealMap,
    excludePantry,
  );
  return {
    text: formatShoppingList(result),
    matchSummary: result.matchSummary,
    priceSummary: result.priceSummary,
    grandTotal: result.grandTotal,
  };
}

/** Preserve the existing text-only shopping-list contract for MCP callers. */
export async function buildShoppingList(
  selectedRecipes: Recipe[],
  householdSize: number,
  existingDealMap?: Map<string, Offer[]>,
  excludePantry = true,
): Promise<string> {
  return (
    await buildShoppingListResult(selectedRecipes, householdSize, existingDealMap, excludePantry)
  ).text;
}
