import { useEffect, useState } from "react";
import { getHealth } from "../api/client";

export function useApiHealth() {
  const [status, setStatus] = useState<"loading" | "connected" | "unavailable">("loading");
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    void getHealth(signal).then(
      () => {
        if (!controller.signal.aborted) setStatus("connected");
      },
      () => {
        if (!controller.signal.aborted) setStatus("unavailable");
      },
    );
    return () => controller.abort();
  }, []);
  return status;
}
