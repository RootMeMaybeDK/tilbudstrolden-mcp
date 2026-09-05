import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDealerCache,
  internalDealCandidateLimit,
  searchDeals,
  searchDealsBatch,
} from "./api.js";

interface RawOfferFixture {
  id: string;
  heading: string;
  dealerId: string;
  store: string;
}

function rawOffer({ id, heading, dealerId, store }: RawOfferFixture) {
  return {
    id,
    heading,
    description: null,
    pricing: { price: 35, pre_price: null, currency: "DKK" },
    quantity: {
      unit: { symbol: "g", si: { symbol: "g", factor: 1 } },
      size: { from: 400, to: 400 },
      pieces: { from: null, to: null },
    },
    branding: { name: store },
    dealer_id: dealerId,
    dealer: { name: store, country: { id: "DK" } },
    run_from: "2026-09-01",
    run_till: "2026-09-07",
    images: { view: null },
  };
}

function dealer(id: string, name: string) {
  return { id, name, website: null, logo: null, country: { id: "DK" } };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("preferred dealer filtering", () => {
  const nonPreferred = Array.from({ length: 8 }, (_, index) =>
    rawOffer({
      id: `other-${index + 1}`,
      heading: `Hakket oksekød ${index + 1}`,
      dealerId: "other-id",
      store: "Other Store",
    }),
  );
  const preferred = rawOffer({
    id: "preferred-9",
    heading: "Hakket oksekød 8-12%",
    dealerId: "bdf5A",
    store: "Føtex",
  });
  const discount365 = rawOffer({
    id: "preferred-365",
    heading: "Coop hakket oksekød 8-12%",
    dealerId: "DWZE1w",
    store: "365discount",
  });
  let searchResponse: ReturnType<typeof rawOffer>[];
  let dealerResponse: ReturnType<typeof dealer>[];
  let searchUrls: URL[];

  beforeEach(() => {
    clearDealerCache();
    searchResponse = [...nonPreferred, preferred, discount365];
    dealerResponse = [
      dealer("other-id", "Other Store"),
      dealer("bdf5A", "Føtex"),
      dealer("DWZE1w", "365discount"),
    ];
    searchUrls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/dealers?")) {
          return jsonResponse(dealerResponse);
        }
        searchUrls.push(new URL(url));
        return jsonResponse(searchResponse);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDealerCache();
  });

  it("sends one deterministic dealer_ids parameter and the requested limit upstream", async () => {
    const offers = await searchDeals("hakket oksekød", 8, "DK", {
      dealerIds: new Set(["DWZE1w", "bdf5A"]),
    });

    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0].searchParams.getAll("dealer_ids")).toEqual(["DWZE1w,bdf5A"]);
    expect(searchUrls[0].searchParams.get("limit")).toBe("8");
    expect(searchUrls[0].searchParams.get("limit")).not.toBe("24");
    expect(offers.map((offer) => offer.id)).toEqual(["preferred-9", "preferred-365"]);
  });

  it("keeps public search global and backwards compatible without preferred IDs", async () => {
    const offers = await searchDeals("hakket oksekød", 8, "DK");

    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0].searchParams.has("dealer_ids")).toBe(false);
    expect(searchUrls[0].searchParams.get("limit")).toBe("24");
    expect(offers).toHaveLength(8);
    expect(offers.map((offer) => offer.id)).toEqual(nonPreferred.map((offer) => offer.id));
  });

  it("treats an empty dealerIds set as the unchanged global search", async () => {
    const offers = await searchDeals("hakket oksekød", 8, "DK", { dealerIds: new Set() });

    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0].searchParams.has("dealer_ids")).toBe(false);
    expect(searchUrls[0].searchParams.get("limit")).toBe("24");
    expect(offers.map((offer) => offer.id)).toEqual(nonPreferred.map((offer) => offer.id));
  });

  it("defensively removes unexpected dealer IDs returned by upstream", async () => {
    searchResponse = [preferred, nonPreferred[0]];

    const offers = await searchDeals("hakket oksekød", 8, "DK", {
      dealerIds: new Set(["bdf5A"]),
    });

    expect(offers.map((offer) => offer.id)).toEqual(["preferred-9"]);
  });

  it("keeps an explicitly requested dealer omitted by the DK dealer directory", async () => {
    dealerResponse = [dealer("other-id", "Other Store")];
    searchResponse = [preferred];

    const offers = await searchDeals("hakket oksekød", 8, "DK", {
      dealerIds: new Set(["bdf5A"]),
    });

    expect(offers.map((offer) => offer.id)).toEqual(["preferred-9"]);
  });

  it("keeps the existing DK allow-list behavior without an explicit dealer filter", async () => {
    dealerResponse = [dealer("other-id", "Other Store")];
    searchResponse = [preferred];

    const offers = await searchDeals("hakket oksekød", 8, "DK");

    expect(offers).toEqual([]);
    expect(searchUrls[0].searchParams.has("dealer_ids")).toBe(false);
    expect(searchUrls[0].searchParams.get("limit")).toBe("24");
  });

  it("propagates preferred dealer filtering through batch searches", async () => {
    const deals = await searchDealsBatch(["hakket oksekød"], 8, "DK", {
      dealerIds: new Set(["bdf5A"]),
    });

    expect(deals.get("hakket oksekød")?.map((offer) => offer.id)).toEqual(["preferred-9"]);
    expect(searchUrls[0].searchParams.getAll("dealer_ids")).toEqual(["bdf5A"]);
    expect(searchUrls[0].searchParams.get("limit")).toBe("8");
  });
});

describe("internal deal candidate budget", () => {
  it("uses the base limit for one dealer", () => {
    expect(internalDealCandidateLimit(new Set(["DWZE1w"]))).toBe(8);
  });

  it("allocates the base limit across five dealers", () => {
    expect(
      internalDealCandidateLimit(new Set(["11deC", "9ba51", "bdf5A", "71c90", "DWZE1w"])),
    ).toBe(40);
  });

  it("never exceeds the upstream limit of 100", () => {
    const manyDealerIds = new Set(Array.from({ length: 20 }, (_, index) => `dealer-${index}`));

    expect(internalDealCandidateLimit(manyDealerIds)).toBe(100);
  });
});
