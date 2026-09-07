import { describe, expect, it, vi } from "vitest";
import {
  HTTP_BASE,
  jsonRequest,
  makeHttpOffer,
  makeHttpStore,
  useHttpDatastore,
} from "../../test/http-fixtures.js";
import * as api from "../api.js";
import { getLocale } from "../locales.js";
import * as store from "../store.js";
import { createHttpApp } from "./app.js";

describe("deal HTTP read routes", () => {
  useHttpDatastore();
  it("returns curated country-specific IDs and aliases without upstream calls", async () => {
    const data = makeHttpStore();
    data.household.country = "NO";
    await store.save(data);
    const res = await createHttpApp().request(`${HTTP_BASE}/api/stores`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      country: "NO",
      source: "known-stores",
      knownStores: getLocale("NO").knownStores,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("delegates raw global search without applying preferred-store filtering", async () => {
    const search = vi.spyOn(api, "searchDeals").mockResolvedValueOnce([makeHttpOffer()]);
    const res = await createHttpApp().request(
      `${HTTP_BASE}/api/deals/search`,
      jsonRequest({ query: " mælk " }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: " mælk ",
      country: "DK",
      currency: "DKK",
      offers: [makeHttpOffer()],
    });
    expect(search).toHaveBeenCalledExactlyOnceWith(" mælk ", 20, "DK");
  });
  it("passes a decoded dealer ID and bounded limit to the core API", async () => {
    const offers = vi.spyOn(api, "getStoreOffers").mockResolvedValueOnce([]);
    const res = await createHttpApp().request(
      `${HTTP_BASE}/api/stores/${encodeURIComponent("id/+%20")}/offers?limit=8`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dealerId: "id/+%20", offers: [] });
    expect(offers).toHaveBeenCalledExactlyOnceWith("id/+%20", 8);
  });
  it.each([0, 101, 1.5])("rejects an out-of-range read limit %s before upstream", async (limit) => {
    const offers = vi.spyOn(api, "getStoreOffers");
    const search = vi.spyOn(api, "searchDeals");
    expect(
      (await createHttpApp().request(`${HTTP_BASE}/api/stores/id/offers?limit=${limit}`)).status,
    ).toBe(400);
    expect(
      (
        await createHttpApp().request(
          `${HTTP_BASE}/api/deals/search`,
          jsonRequest({ query: "milk", limit }),
        )
      ).status,
    ).toBe(400);
    expect(offers).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
  it("maps upstream failures using the common envelope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(api, "getStoreOffers").mockRejectedValueOnce(new Error("private"));
    const res = await createHttpApp().request(`${HTTP_BASE}/api/stores/id/offers`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
