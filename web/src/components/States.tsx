export function LoadingState({ message = "Indlæser…" }: { message?: string }) {
  return (
    <p role="status" className="muted">
      {message}
    </p>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <p role="alert" className="error-state">
      {message}
    </p>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="muted">{message}</p>;
}
