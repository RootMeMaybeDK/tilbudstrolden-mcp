// etilbudsavis.dk / Tjek API client

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const BASE_URL = "https://api.etilbudsavis.dk/v2";
const USER_AGENT = `tilbudstrolden-mcp/${version}`;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const MAX_CONCURRENT = 4;
const BASE_INTERNAL_CANDIDATE_LIMIT = 8;
const MAX_UPSTREAM_SEARCH_LIMIT = 100;

export interface Offer {
  id: string;
  heading: string;
  description: string | null;
  price: number | null;
  prePrice: number | null;
  currency: string;
  quantity: number | null;
  unit: string | null;
  pricePerUnit: string | null;
  store: string;
  storeId: string;
  validFrom: string;
  validUntil: string;
  imageUrl: string | null;
}

export interface Dealer {
  id: string;
  name: string;
  website: string | null;
  logoUrl: string | null;
  country: string;
}

export interface DealSearchOptions {
  /** Restrict results to these stable dealer IDs before applying the result limit. */
  dealerIds?: ReadonlySet<string>;
}

/** Bounded candidate pool used by internal scoring and shopping searches. */
export function internalDealCandidateLimit(dealerIds: ReadonlySet<string>): number {
  const dealerCount = Math.max(dealerIds.size, 1);
  return Math.min(BASE_INTERNAL_CANDIDATE_LIMIT * dealerCount, MAX_UPSTREAM_SEARCH_LIMIT);
}

interface RawOffer {
  id: string;
  heading: string;
  description: string | null;
  pricing: { price: number | null; pre_price: number | null; currency: string };
  quantity: {
    unit: { symbol: string; si: { symbol: string; factor: number } } | null;
    size: { from: number | null; to: number | null } | null;
    pieces: { from: number | null; to: number | null } | null;
  };
  branding: { name: string } | null;
  dealer_id: string;
  dealer: { name: string } | null;
  run_from: string;
  run_till: string;
  images: { view: string | null } | null;
}

/** Extended raw offer with optional dealer country (present in some API responses) */
interface RawOfferWithCountry extends RawOffer {
  dealer: { name: string; country?: { id: string } } | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  DKK: "kr",
  NOK: "kr",
  SEK: "kr",
  EUR: "€",
};

function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

// Units that are reported per gram/ml but should be displayed per kg/L.
const KILO_UNIT_CONVERSIONS: Record<string, { factor: number; suffix: string }> = {
  g: { factor: 1000, suffix: "kg" },
  ml: { factor: 1000, suffix: "L" },
};

function unitPricePerUnit(price: number, qty: number, unitSymbol: string, sym: string): string {
  const conv = KILO_UNIT_CONVERSIONS[unitSymbol];
  if (conv && qty < conv.factor) {
    return `${((price / qty) * conv.factor).toFixed(2)} ${sym}/${conv.suffix}`;
  }
  return `${(price / qty).toFixed(2)} ${sym}/${unitSymbol}`;
}

interface QuantityFields {
  quantity: number | null;
  unit: string | null;
  pieces: number | null;
}

function readQuantityFields(raw: RawOffer): QuantityFields {
  return {
    quantity: raw.quantity?.size?.from ?? null,
    unit: raw.quantity?.unit?.symbol ?? null,
    pieces: raw.quantity?.pieces?.from ?? null,
  };
}

interface PricingFields {
  price: number | null;
  prePrice: number | null;
  currency: string;
  sym: string;
}

function readPricingFields(raw: RawOffer): PricingFields {
  const currency = raw.pricing?.currency ?? "DKK";
  return {
    price: raw.pricing?.price ?? null,
    prePrice: raw.pricing?.pre_price ?? null,
    currency,
    sym: currencySymbol(currency),
  };
}

function readStore(raw: RawOffer): string {
  return raw.branding?.name ?? raw.dealer?.name ?? "Unknown";
}

/** A positive size with a unit symbol, e.g. 500 g — enough to price per kg/L. */
function hasMeasuredQuantity(
  q: QuantityFields,
): q is QuantityFields & { quantity: number; unit: string } {
  return q.quantity !== null && q.quantity > 0 && q.unit !== null && q.unit !== "";
}

/** A positive piece count, e.g. eggs sold per piece. */
function hasPieceCount(q: QuantityFields): q is QuantityFields & { pieces: number } {
  return q.pieces !== null && q.pieces > 0;
}

function computePricePerUnit(price: number, q: QuantityFields, sym: string): string | null {
  if (hasMeasuredQuantity(q)) {
    return unitPricePerUnit(price, q.quantity, q.unit, sym);
  }
  if (hasPieceCount(q)) {
    return `${(price / q.pieces).toFixed(2)} ${sym}/pcs`;
  }
  return null;
}

function parseOffer(raw: RawOffer): Offer {
  const pricing = readPricingFields(raw);
  const q = readQuantityFields(raw);
  const pricePerUnit =
    pricing.price !== null ? computePricePerUnit(pricing.price, q, pricing.sym) : null;

  return {
    id: raw.id,
    heading: raw.heading,
    description: raw.description,
    price: pricing.price,
    prePrice: pricing.prePrice,
    currency: pricing.currency,
    quantity: q.quantity,
    unit: q.unit,
    pricePerUnit,
    store: readStore(raw),
    storeId: raw.dealer_id,
    validFrom: raw.run_from,
    validUntil: raw.run_till,
    imageUrl: raw.images?.view ?? null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff: 500ms, 1s, 2s... */
const backoffDelay = (attempt: number) => RETRY_BASE_MS * 2 ** attempt;

type FetchAttempt<T> = { retryable: false; body: T } | { retryable: true; error: Error };

/**
 * One request attempt. Rate limits and server errors come back as retryable;
 * any other non-OK status throws, since retrying will not help.
 */
async function attemptFetch<T>(url: string): Promise<FetchAttempt<T>> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT },
  });

  if (res.status === 429 || res.status >= 500) {
    return { retryable: true, error: new Error(`API returned ${res.status}`) };
  }
  if (!res.ok) {
    throw new Error(`API request failed (${res.status})`);
  }
  return { retryable: false, body: (await res.json()) as T };
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await attemptFetch<T>(url);
      if (!result.retryable) return result.body;
      lastError = result.error;
      await sleep(backoffDelay(attempt));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(backoffDelay(attempt));
      }
    }
  }

  throw lastError ?? new Error("API request failed after retries");
}

// Simple concurrency limiter for batch operations
async function withConcurrencyLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  const executing: Set<Promise<void>> = new Set();

  for (let i = 0; i < tasks.length; i++) {
    const idx = i;
    const p = tasks[idx]().then((result) => {
      results[idx] = result;
    });
    const tracked = p.finally(() => executing.delete(tracked));
    executing.add(tracked);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results as T[];
}

// --- Country-based store filter ---

const dealerCacheByCountry = new Map<string, Set<string>>();

/** Fetch and cache dealer IDs for a country (used for DK where /dealers works). */
export async function getDealerIds(countryId = "DK"): Promise<Set<string>> {
  const cached = dealerCacheByCountry.get(countryId);
  if (cached) return cached;
  const dealers = await listStores(countryId);
  const ids = new Set(dealers.map((d) => d.id));
  dealerCacheByCountry.set(countryId, ids);
  return ids;
}

/** @deprecated Use getDealerIds() instead */
export async function getDanishDealerIds(): Promise<Set<string>> {
  return getDealerIds("DK");
}

/** Clear the dealer cache (for testing). */
export function clearDealerCache(): void {
  dealerCacheByCountry.clear();
}

export async function searchDeals(
  query: string,
  limit = 20,
  countryId = "DK",
  options: DealSearchOptions = {},
): Promise<Offer[]> {
  const requestedDealerIds = options.dealerIds;
  const hasDealerFilter = Boolean(requestedDealerIds && requestedDealerIds.size > 0);

  // Preserve the existing global over-fetch, but let upstream rank within
  // preferred dealers when stable IDs are available.
  const params = new URLSearchParams({
    query,
    limit: String(hasDealerFilter ? limit : limit * 3),
    country_id: countryId,
  });
  if (requestedDealerIds && requestedDealerIds.size > 0) {
    // Set iteration preserves the household store-priority insertion order.
    params.set("dealer_ids", [...requestedDealerIds].join(","));
  }
  const raw = await fetchJson<RawOffer[]>(`${BASE_URL}/offers/search?${params}`);

  let offers: Offer[];
  if (countryId === "DK") {
    // DK: /dealers endpoint works, use allow-list for best accuracy
    const countryDealerIds = await getDealerIds("DK");
    const allowedDealerIds = hasDealerFilter
      ? new Set([...countryDealerIds, ...(requestedDealerIds ?? [])])
      : countryDealerIds;
    offers = raw.map(parseOffer).filter((o) => allowedDealerIds.has(o.storeId));
  } else {
    // NO/SE/FI: /dealers endpoint ignores country_id, so filter by dealer.country
    // from the raw response instead
    offers = raw
      .filter((o) => {
        const dc = (o as RawOfferWithCountry).dealer?.country?.id;
        return !dc || dc === countryId;
      })
      .map(parseOffer);
  }

  if (requestedDealerIds && requestedDealerIds.size > 0) {
    offers = offers.filter((offer) => requestedDealerIds.has(offer.storeId));
  }

  return offers.slice(0, limit);
}

export async function getStoreOffers(dealerId: string, limit = 50): Promise<Offer[]> {
  const params = new URLSearchParams({
    dealer_id: dealerId,
    limit: String(limit),
  });
  const raw = await fetchJson<RawOffer[]>(`${BASE_URL}/offers?${params}`);
  return raw.map(parseOffer);
}

/**
 * Search deals for multiple queries in parallel (with concurrency limit),
 * deduplicating queries. Returns a map of query -> matching offers.
 */
export async function searchDealsBatch(
  queries: string[],
  limit = 5,
  countryId = "DK",
  options: DealSearchOptions = {},
): Promise<Map<string, Offer[]>> {
  const unique = [...new Set(queries)];
  const tasks = unique.map((q) => async () => {
    const offers = await searchDeals(q, limit, countryId, options);
    return [q, offers] as const;
  });

  const results = await withConcurrencyLimit(tasks, MAX_CONCURRENT);
  return new Map(results);
}

export async function listStores(countryId = "DK"): Promise<Dealer[]> {
  const params = new URLSearchParams({
    country_id: countryId,
    limit: "100",
  });

  interface RawDealer {
    id: string;
    name: string;
    website: string | null;
    logo: string | null;
    country: { id: string };
  }

  const raw = await fetchJson<RawDealer[]>(`${BASE_URL}/dealers?${params}`);
  return raw.map((d) => ({
    id: d.id,
    name: d.name,
    website: d.website,
    logoUrl: d.logo,
    country: d.country?.id ?? countryId,
  }));
}
