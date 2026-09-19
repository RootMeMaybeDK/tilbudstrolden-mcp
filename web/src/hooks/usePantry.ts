import { useEffect, useState } from "react";
import type { PantryHttpResponse } from "../../../src/contracts/http";
import { ApiError } from "../api/client";
import { getPantry } from "../api/pantry";

type PantryState =
  | { status: "loading" }
  | { status: "success"; pantry: PantryHttpResponse }
  | { status: "error"; error: ApiError };

export function usePantry(): PantryState {
  const [state, setState] = useState<PantryState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void getPantry(controller.signal).then(
      (pantry) => {
        if (!controller.signal.aborted) setState({ status: "success", pantry });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            error instanceof ApiError
              ? error
              : new ApiError("Kunne ikke hente pantry.", "protocol"),
        });
      },
    );
    return () => controller.abort();
  }, []);
  return state;
}
