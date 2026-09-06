import { type CountryCode, isValidCountry, SUPPORTED_COUNTRIES } from "../locales.js";
import * as store from "../store.js";

const ALL_DAYS_HOME = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: true,
  sunday: true,
};

export interface UpdateHouseholdSettingsInput {
  country?: string;
  people?: store.Person[];
  stores?: store.StorePreference[];
  defaultServings?: number;
}

export type UpdateHouseholdSettingsResult =
  | { status: "updated"; household: store.Household }
  | { status: "invalid-country"; country: string; supportedCountries: CountryCode[] };

/** Validate and normalize a household patch before applying it atomically in the store. */
export async function updateHouseholdSettings(
  input: UpdateHouseholdSettingsInput,
): Promise<UpdateHouseholdSettingsResult> {
  const patch: Partial<store.Household> = {};

  // Preserve the existing truthiness semantics: an empty country means no update.
  if (input.country) {
    if (!isValidCountry(input.country)) {
      return {
        status: "invalid-country",
        country: input.country,
        supportedCountries: [...SUPPORTED_COUNTRIES],
      };
    }
    patch.country = input.country.toUpperCase();
  }
  if (input.people) {
    patch.people = input.people.map((person) => ({
      ...person,
      defaultSchedule: { ...ALL_DAYS_HOME, ...person.defaultSchedule },
    }));
  }
  if (input.stores) patch.stores = input.stores;
  // Preserve the existing behavior where zero is accepted by the wire schema but omitted here.
  if (input.defaultServings) patch.defaultServings = input.defaultServings;

  const household = await store.updateHousehold(patch);
  return { status: "updated", household };
}
