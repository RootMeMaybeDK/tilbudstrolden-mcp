import { useEffect } from "react";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { usePantry } from "../hooks/usePantry";

export function PantryPage() {
  const state = usePantry();
  useEffect(() => {
    document.title = "Pantry · Tilbudstrolden";
  }, []);
  return (
    <section className="page-card pantry-page">
      <h1>Pantry</h1>
      {state.status === "loading" && <LoadingState message="Henter pantry…" />}
      {state.status === "error" && (
        <ErrorState message={`Pantry kunne ikke hentes. ${state.error.message}`} />
      )}
      {state.status === "success" && (
        <>
          <p className="muted">
            {state.pantry.items.length} {state.pantry.items.length === 1 ? "vare" : "varer"}
          </p>
          {state.pantry.items.length === 0 ? (
            <EmptyState message="Ingen varer i pantry." />
          ) : (
            <ul className="pantry-list">
              {state.pantry.items.map((item, index) => (
                // No stable IDs in this read-only snapshot. Revisit before edit/reorder/delete animation.
                // biome-ignore lint/suspicious/noArrayIndexKey: Preserve duplicates and backend order without inventing IDs.
                <li key={index}>{item.trim() === "" ? "Ikke angivet" : item}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
