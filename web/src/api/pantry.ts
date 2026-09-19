import type { PantryHttpResponse } from "../../../src/contracts/http";
import { api } from "./client";

export function getPantry(signal?: AbortSignal): Promise<PantryHttpResponse> {
  return api.request<PantryHttpResponse>("/pantry", { signal });
}
