import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { type GeneratePlanInput, generatePlan, type PlanningResult } from "../api/planning";

type MealPlanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "result"; result: PlanningResult }
  | { status: "error"; error: ApiError };

export function useMealPlan() {
  const [state, setState] = useState<MealPlanState>({ status: "idle" });
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    },
    [],
  );

  async function generate(input: GeneratePlanInput) {
    // Synchronous gate also blocks a second submit before React renders disabled controls.
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setState({ status: "loading" });
    const isCurrent = () => activeRequest.current === controller && !controller.signal.aborted;
    try {
      const result = await generatePlan(input, controller.signal);
      if (isCurrent()) setState({ status: "result", result });
    } catch (error: unknown) {
      if (isCurrent()) {
        setState({
          status: "error",
          error:
            error instanceof ApiError
              ? error
              : new ApiError("Kunne ikke generere madplanen.", "protocol"),
        });
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function cancel() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setState({ status: "idle" });
  }

  return { state, generate, cancel };
}
