import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { planningDto, scoringDto, shoppingDto, spendHistoryDto } from "../http/dto.js";
import type {
  DealSearchHttpResponse,
  ErrorHttpResponse,
  HealthHttpResponse,
  HouseholdHttpResponse,
  InsufficientRecipesHttpResult,
  MealHistoryHttpResponse,
  NoValidPlanHttpResult,
  PantryHttpResponse,
  PlanAndShopHttpErrorResponse,
  PlanAndShopHttpResponse,
  RecipeScoringHttpResponse,
  RecipesHttpResponse,
  RecordMealHttpResponse,
  RecordSpendHttpResponse,
  RemoveRecipeHttpResponse,
  SaveRecipeHttpResponse,
  ShoppingHttpErrorResponse,
  ShoppingHttpResponse,
  SpendHistoryHttpResponse,
  StoreOffersHttpResponse,
  StoresHttpResponse,
  SuccessfulPlanAndShopHttpResponse,
} from "./http.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

describe("HTTP response contracts", () => {
  it("typechecks these assertions with TypeScript, including negative assertions", () => {
    // Vitest normally transpiles tests, and the production tsconfig excludes *.test.ts.
    // Explicitly check this file so expectTypeOf and @ts-expect-error run in npm test too.
    const filename = fileURLToPath(import.meta.url);
    const configPath = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const program = ts.createProgram([filename], { ...parsed.options, noEmit: true });
    const diagnostics = [
      ...(config.error ? [config.error] : []),
      ...parsed.errors,
      ...ts.getPreEmitDiagnostics(program),
    ];
    expect(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => "\n",
      }),
    ).toBe("");
  });

  it("narrows planning success and both failures using status alone", () => {
    function check(result: PlanAndShopHttpResponse) {
      if (result.status === "ok") {
        expectTypeOf(result).toEqualTypeOf<SuccessfulPlanAndShopHttpResponse>();
        expectTypeOf<SuccessfulPlanAndShopHttpResponse["status"]>().toEqualTypeOf<"ok">();
        expectTypeOf(result.plan).toEqualTypeOf<SuccessfulPlanAndShopHttpResponse["plan"]>();
        expectTypeOf(result.shopping).toEqualTypeOf<ShoppingHttpResponse>();
        // @ts-expect-error Available recipe count belongs only to the insufficient variant.
        result.availableRecipeCount;
      } else if (result.status === "insufficient-recipes") {
        expectTypeOf(result).toEqualTypeOf<InsufficientRecipesHttpResult>();
        expectTypeOf(result.availableRecipeCount).toEqualTypeOf<number>();
        // @ts-expect-error Failure responses do not contain a plan.
        result.plan;
        // @ts-expect-error Failure responses do not contain shopping.
        result.shopping;
      } else {
        expectTypeOf(result).toEqualTypeOf<NoValidPlanHttpResult>();
        expectTypeOf(result.status).toEqualTypeOf<"no-valid-plan">();
        // @ts-expect-error Failure responses do not contain a plan.
        result.plan;
        // @ts-expect-error Failure responses do not contain shopping.
        result.shopping;
        // @ts-expect-error This failure has no available recipe count.
        result.availableRecipeCount;
      }
    }
    expectTypeOf(check).parameter(0).toEqualTypeOf<ReturnType<typeof planningDto>>();
  });

  it("describes the nullable spend average and the DTO builder's exact return type", () => {
    type ReadyHistory = Extract<SpendHistoryHttpResponse, { status: "ready" }>;
    expectTypeOf<ReadyHistory["averagePerWeek"]>().toEqualTypeOf<number | null>();
    expectTypeOf<ReturnType<typeof spendHistoryDto>>().toEqualTypeOf<SpendHistoryHttpResponse>();
  });

  it("exposes the matched purchase subtotal without the legacy total or execution fields", () => {
    expectTypeOf<ReturnType<typeof shoppingDto>>().toEqualTypeOf<ShoppingHttpResponse>();
    expectTypeOf<ReturnType<typeof scoringDto>>().toEqualTypeOf<RecipeScoringHttpResponse>();
    expectTypeOf<
      ShoppingHttpResponse["priceSummary"]["matchedPurchaseSubtotal"]
    >().toEqualTypeOf<number>();
    expectTypeOf<"grandTotal">().not.toExtend<keyof ShoppingHttpResponse>();
    expectTypeOf<"dealMap">().not.toExtend<keyof RecipeScoringHttpResponse>();
    expectTypeOf<"locale">().not.toExtend<keyof ShoppingHttpResponse>();
  });

  it("keeps all central response contracts JSON-compatible", () => {
    type Responses =
      | ErrorHttpResponse
      | HealthHttpResponse
      | HouseholdHttpResponse
      | PantryHttpResponse
      | RecipesHttpResponse
      | SaveRecipeHttpResponse
      | RemoveRecipeHttpResponse
      | RecipeScoringHttpResponse
      | ShoppingHttpResponse
      | ShoppingHttpErrorResponse
      | PlanAndShopHttpResponse
      | PlanAndShopHttpErrorResponse
      | StoresHttpResponse
      | DealSearchHttpResponse
      | StoreOffersHttpResponse
      | RecordMealHttpResponse
      | MealHistoryHttpResponse
      | RecordSpendHttpResponse
      | SpendHistoryHttpResponse;
    expectTypeOf<Responses>().toExtend<JsonValue>();
    expectTypeOf<Map<string, string>>().not.toExtend<JsonValue>();
    expectTypeOf<Set<string>>().not.toExtend<JsonValue>();
    expectTypeOf<Date>().not.toExtend<JsonValue>();
    expectTypeOf<() => string>().not.toExtend<JsonValue>();
  });

  it("keeps the contract module import-free and type-only", () => {
    const filename = fileURLToPath(new URL("./http.ts", import.meta.url));
    const source = ts.sys.readFile(filename);
    if (source === undefined) throw new Error("Missing HTTP contract module");
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
    expect(
      ast.statements.every(
        (node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
      ),
    ).toBe(true);
  });
});
