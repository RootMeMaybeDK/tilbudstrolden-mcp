import { useEffect, useState } from "react";
import type { HouseholdHttpResponse } from "../../../src/contracts/http";
import { ApiError } from "../api/client";
import { getHousehold } from "../api/household";

type HouseholdState =
  | { status: "loading" }
  | { status: "success"; household: HouseholdHttpResponse }
  | { status: "error"; error: ApiError };

export function useHousehold(): HouseholdState {
  const [state, setState] = useState<HouseholdState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void getHousehold(controller.signal).then(
      (household) => {
        if (!controller.signal.aborted) setState({ status: "success", household });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            error instanceof ApiError
              ? error
              : new ApiError("Kunne ikke hente husstanden.", "protocol"),
        });
      },
    );
    return () => controller.abort();
  }, []);
  return state;
}
