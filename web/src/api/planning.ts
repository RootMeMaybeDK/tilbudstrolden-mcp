import type {
  InsufficientRecipesHttpResult,
  NoValidPlanHttpResult,
  PlanAndShopHttpResponse,
} from "../../../src/contracts/http";
import { ApiError, api } from "./client";

// Request subset supported by this UI; shared HTTP contracts currently describe responses only.
export type GeneratePlanInput = { days: number; people?: number };

// Validate only the fields consumed from unknown error.result; do not claim the full DTO is valid.
type PlanningFailure =
  | Pick<InsufficientRecipesHttpResult, "status" | "days" | "availableRecipeCount">
  | Pick<NoValidPlanHttpResult, "status" | "days">;
export type PlanningResult = Extract<PlanAndShopHttpResponse, { status: "ok" }> | PlanningFailure;

function isPlanningFailure(value: unknown): value is PlanningFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (
    !("days" in value) ||
    typeof value.days !== "number" ||
    !Number.isSafeInteger(value.days) ||
    value.days < 1
  )
    return false;
  if (!("status" in value)) return false;
  if (value.status === "no-valid-plan") return true;
  return (
    value.status === "insufficient-recipes" &&
    "availableRecipeCount" in value &&
    typeof value.availableRecipeCount === "number" &&
    Number.isSafeInteger(value.availableRecipeCount) &&
    value.availableRecipeCount >= 0
  );
}

export async function generatePlan(
  input: GeneratePlanInput,
  signal?: AbortSignal,
): Promise<PlanningResult> {
  try {
    return await api.request<Extract<PlanAndShopHttpResponse, { status: "ok" }>>("/plan-and-shop", {
      method: "POST",
      body: input,
      signal,
    });
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 422 && isPlanningFailure(error.result)) {
      const result = error.result;
      if (
        (result.status === "insufficient-recipes" && error.code === "INSUFFICIENT_RECIPES") ||
        (result.status === "no-valid-plan" && error.code === "NO_VALID_PLAN")
      )
        return result;
    }
    throw error;
  }
}
