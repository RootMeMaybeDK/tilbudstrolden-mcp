import type { Hono } from "hono";
import { z } from "zod";
import { getStoreOffers, searchDeals } from "../api.js";
import type {
  DealSearchHttpResponse,
  StoreOffersHttpResponse,
  StoresHttpResponse,
} from "../contracts/http.js";
import { getLocale } from "../locales.js";
import { getHousehold } from "../store.js";
import { errorBody, parseJsonBody } from "./errors.js";

const searchInput = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
const offerLimit = z.coerce.number().int().min(1).max(100).optional().default(50);

export function registerDealRoutes(app: Hono): void {
  app.get("/api/stores", async (c) => {
    const locale = getLocale((await getHousehold()).country);
    // This is the curated directory, including aliases; do not claim an exhaustive upstream directory.
    return c.json({
      country: locale.country,
      source: "known-stores",
      knownStores: locale.knownStores,
    } satisfies StoresHttpResponse);
  });
  app.post("/api/deals/search", async (c) => {
    const input = await parseJsonBody(c, searchInput);
    const locale = getLocale((await getHousehold()).country);
    const offers = await searchDeals(input.query, input.limit, locale.country);
    return c.json({
      query: input.query,
      country: locale.country,
      currency: locale.currency,
      offers,
    } satisfies DealSearchHttpResponse);
  });
  app.get("/api/stores/:dealerId/offers", async (c) => {
    const parsed = offerLimit.safeParse(c.req.query("limit"));
    if (!parsed.success)
      return c.json(errorBody("INVALID_REQUEST", "limit must be an integer from 1 to 100."), 400);
    const dealerId = c.req.param("dealerId");
    return c.json({
      dealerId,
      offers: await getStoreOffers(dealerId, parsed.data),
    } satisfies StoreOffersHttpResponse);
  });
}
