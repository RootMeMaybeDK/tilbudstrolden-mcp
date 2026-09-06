import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Household } from "../store.js";

vi.mock("../store.js", () => ({
  updateHousehold: vi.fn(),
}));

const store = await import("../store.js");
const { updateHouseholdSettings } = await import("./household-service.js");

function makeHousehold(overrides: Partial<Household> = {}): Household {
  return {
    people: [],
    stores: [],
    defaultServings: 2,
    country: "DK",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.updateHousehold).mockImplementation(async (patch) =>
    makeHousehold(patch as Partial<Household>),
  );
});

describe("updateHouseholdSettings", () => {
  it("normalizes a valid lowercase country and returns the updated household", async () => {
    const result = await updateHouseholdSettings({ country: "no" });

    expect(store.updateHousehold).toHaveBeenCalledWith({ country: "NO" });
    expect(result).toEqual({ status: "updated", household: makeHousehold({ country: "NO" }) });
  });

  it.each(["US", " DK "])("returns invalid-country for %j without writing", async (country) => {
    const result = await updateHouseholdSettings({ country });

    expect(result).toEqual({
      status: "invalid-country",
      country,
      supportedCountries: ["DK", "NO", "SE", "FI"],
    });
    expect(store.updateHousehold).not.toHaveBeenCalled();
  });

  it("preserves the existing empty-country no-op write", async () => {
    await expect(updateHouseholdSettings({ country: "" })).resolves.toMatchObject({
      status: "updated",
    });
    expect(store.updateHousehold).toHaveBeenCalledWith({});
  });

  it("passes only supplied patch fields to the store", async () => {
    await updateHouseholdSettings({ defaultServings: 3 });
    expect(store.updateHousehold).toHaveBeenCalledWith({ defaultServings: 3 });
  });

  it("preserves explicit empty people and store replacements", async () => {
    await updateHouseholdSettings({ people: [], stores: [] });
    expect(store.updateHousehold).toHaveBeenCalledWith({ people: [], stores: [] });
  });

  it("fills all seven home days before applying explicit schedule overrides", async () => {
    await updateHouseholdSettings({
      people: [
        {
          name: "Helle",
          dietaryRestrictions: ["no fish"],
          defaultSchedule: { wednesday: false, sunday: false },
        },
      ],
    });

    expect(vi.mocked(store.updateHousehold).mock.calls[0][0].people).toEqual([
      {
        name: "Helle",
        dietaryRestrictions: ["no fish"],
        defaultSchedule: {
          monday: true,
          tuesday: true,
          wednesday: false,
          thursday: true,
          friday: true,
          saturday: true,
          sunday: false,
        },
      },
    ]);
  });

  it("preserves unknown and duplicate preferred stores in input order", async () => {
    const stores = [
      { name: " Unknown ", dealerId: " raw-id ", priority: 2 },
      { name: " Unknown ", dealerId: " raw-id ", priority: 2 },
    ];

    await updateHouseholdSettings({ stores });

    expect(store.updateHousehold).toHaveBeenCalledWith({ stores });
    expect(vi.mocked(store.updateHousehold).mock.calls[0][0].stores).toBe(stores);
  });

  it("does not trim or canonicalize person data", async () => {
    await updateHouseholdSettings({
      people: [
        {
          name: " Helle ",
          dietaryRestrictions: [" No Fish "],
          defaultSchedule: { customDay: false },
        },
      ],
    });

    expect(vi.mocked(store.updateHousehold).mock.calls[0][0].people?.[0]).toMatchObject({
      name: " Helle ",
      dietaryRestrictions: [" No Fish "],
      defaultSchedule: { customDay: false },
    });
  });

  it("preserves the existing defaultServings zero omission", async () => {
    await updateHouseholdSettings({ defaultServings: 0 });
    expect(store.updateHousehold).toHaveBeenCalledWith({});
  });

  it("continues forwarding negative defaultServings", async () => {
    await updateHouseholdSettings({ defaultServings: -1 });
    expect(store.updateHousehold).toHaveBeenCalledWith({ defaultServings: -1 });
  });

  it("continues calling the store for an empty patch", async () => {
    await updateHouseholdSettings({});
    expect(store.updateHousehold).toHaveBeenCalledOnce();
    expect(store.updateHousehold).toHaveBeenCalledWith({});
  });

  it("propagates the exact store error object", async () => {
    const error = new Error("datastore busy");
    vi.mocked(store.updateHousehold).mockRejectedValueOnce(error);

    await expect(updateHouseholdSettings({ country: "DK" })).rejects.toBe(error);
  });
});
