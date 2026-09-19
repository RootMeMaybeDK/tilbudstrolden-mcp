import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { generatePlan } from "./planning";

function fail(result: unknown, code = "INSUFFICIENT_RECIPES", status = 422) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        error: { code, message: "Planning request failed." },
        result,
      },
      { status },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("planning error boundary", () => {
  it.each([
    { status: "insufficient-recipes", days: 3, availableRecipeCount: 0 },
    { status: "no-valid-plan", days: 3 },
  ])("narrows only the required fields for $status", async (result) => {
    const code =
      result.status === "insufficient-recipes" ? "INSUFFICIENT_RECIPES" : "NO_VALID_PLAN";
    const fetchMock = fail(result, code);
    expect(await generatePlan({ days: 3 })).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    "insufficient-recipes",
    { status: "unknown", days: 3 },
    { status: "no-valid-plan" },
    { status: "no-valid-plan", days: "3" },
    { status: "no-valid-plan", days: 0 },
    { status: "no-valid-plan", days: 1.5 },
    { status: "insufficient-recipes", days: 3 },
    { status: "insufficient-recipes", days: 3, availableRecipeCount: "2" },
    { status: "insufficient-recipes", days: 3, availableRecipeCount: -1 },
  ])("does not cast a malformed 422 result to a planning outcome: %j", async (result) => {
    const code =
      typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "no-valid-plan"
        ? "NO_VALID_PLAN"
        : "INSUFFICIENT_RECIPES";
    const fetchMock = fail(result, code);
    await expect(generatePlan({ days: 3 })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "INTERNAL_ERROR", status: 422 },
    { code: "INSUFFICIENT_RECIPES", status: 422 },
    { code: "NO_VALID_PLAN", status: 500 },
  ])("requires matching HTTP status and error code: %j", async ({ code, status }) => {
    fail({ status: "no-valid-plan", days: 3 }, code, status);
    await expect(generatePlan({ days: 3 })).rejects.toBeInstanceOf(ApiError);
  });
});
