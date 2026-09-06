export type DealExpiryStatus = "none" | "expired" | "expires-today" | "expires-tomorrow";

export interface DealExpirySnapshot {
  daysRemaining: number;
  status: DealExpiryStatus;
}

/** Days until a deal expires. Negative means already expired. */
export function daysUntilExpiry(validUntil: string | null | undefined, now = new Date()): number {
  if (!validUntil) return 999;
  const expiry = new Date(validUntil);
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** Resolve expiry days and status from one clock snapshot. */
export function getDealExpiry(
  validUntil: string | null | undefined,
  now = new Date(),
): DealExpirySnapshot {
  const daysRemaining = daysUntilExpiry(validUntil, now);
  const status: DealExpiryStatus =
    daysRemaining <= 0
      ? "expired"
      : daysRemaining <= 1
        ? "expires-today"
        : daysRemaining <= 2
          ? "expires-tomorrow"
          : "none";
  return { daysRemaining, status };
}

/** Pure presentation mapping for an already resolved expiry status. */
export function formatExpiryStatus(status: DealExpiryStatus): string {
  if (status === "expired") return " [EXPIRED]";
  if (status === "expires-today") return " [EXPIRES TODAY]";
  if (status === "expires-tomorrow") return " [EXPIRES TOMORROW]";
  return "";
}

/** Compatibility helper for callers that still supply an end date. */
export function expiryTag(validUntil: string | null | undefined): string {
  return formatExpiryStatus(getDealExpiry(validUntil).status);
}
