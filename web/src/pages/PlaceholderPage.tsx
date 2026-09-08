import { useEffect } from "react";
import { EmptyState } from "../components/States";

export function PlaceholderPage({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} · Tilbudstrolden`;
  }, [title]);
  return (
    <section className="page-card">
      <p className="eyebrow">Lokalt fundament</p>
      <h1>{title}</h1>
      <EmptyState message="Denne side er endnu ikke bygget. Her vises ingen husstandsdata." />
    </section>
  );
}
