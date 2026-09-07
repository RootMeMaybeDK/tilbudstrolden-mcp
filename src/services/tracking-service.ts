import { getLocale } from "../locales.js";
import * as store from "../store.js";

async function householdCurrency() {
  const locale = getLocale((await store.getHousehold()).country);
  return { currency: locale.currency, currencySymbol: locale.currencySymbol };
}

export async function recordMeal(input: store.MealLogEntry) {
  const entry = { date: input.date, recipe: input.recipe, people: input.people };
  await store.logMeal(entry);
  return { status: "logged" as const, entry };
}

export async function recordSpend(input: store.SpendLogEntry) {
  const entry = {
    date: input.date,
    store: input.store,
    estimatedTotal: input.estimatedTotal,
    items: input.items,
    notes: input.notes,
  };
  await store.logSpend(entry);
  // Preserve the existing post-commit read: failure here does not undo the logged spend.
  const currency = await householdCurrency();
  return { status: "logged" as const, entry, ...currency };
}

export async function readMealHistory(weeks = 4) {
  return { weeks, entries: await store.getMealHistory(weeks) };
}

export async function readSpendHistory(weeks = 8) {
  const entries = await store.getSpendLog(weeks);
  if (entries.length === 0) return { status: "empty" as const, weeks, entries };
  const total = entries.reduce((sum, entry) => sum + entry.estimatedTotal, 0);
  const averagePerWeek = total / weeks;
  const currency = await householdCurrency();
  return { status: "ready" as const, weeks, entries, total, averagePerWeek, ...currency };
}
