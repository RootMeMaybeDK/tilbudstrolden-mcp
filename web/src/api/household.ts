import type { HouseholdHttpResponse } from "../../../src/contracts/http";
import { api } from "./client";

export function getHousehold(signal?: AbortSignal): Promise<HouseholdHttpResponse> {
  return api.request<HouseholdHttpResponse>("/household", { signal });
}
