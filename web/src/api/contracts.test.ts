import { expectTypeOf, it } from "vitest";
import type { PlanAndShopHttpResponse, ShoppingHttpResponse } from "../../../src/contracts/http";

it("uses the shared planning discriminant without service types or casts", () => {
  // web:typecheck includes this file; Vitest alone only transpiles these assertions.
  function narrow(result: PlanAndShopHttpResponse) {
    if (result.status === "ok") {
      expectTypeOf(result.shopping).toEqualTypeOf<ShoppingHttpResponse>();
      return result.plan;
    }
    if (result.status === "insufficient-recipes") {
      expectTypeOf(result.availableRecipeCount).toEqualTypeOf<number>();
    }
    // @ts-expect-error Failure results do not have a successful shopping result.
    return result.shopping;
  }
  expectTypeOf(narrow).toBeFunction();
});
