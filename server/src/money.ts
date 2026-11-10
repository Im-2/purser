// Decimal-safe money helpers. All internal arithmetic uses integer minor units (cents).
// Never add floats. Anything that cannot be parsed exactly returns null (callers fail closed).

const DECIMAL = /^\d{1,12}(\.\d{1,2})?$/;

/** Parse a money value ("12.50", 12.5, 12) to integer minor units. Null if invalid, negative, zero-ambiguous or >2 decimals. */
export function toMinor(value: unknown): number | null {
  let s: string;
  if (typeof value === "string") s = value.trim();
  else if (typeof value === "number" && Number.isFinite(value)) s = String(value);
  else return null;
  if (!DECIMAL.test(s)) return null; // rejects exponent notation, negatives, 3+ decimals
  const [whole, frac = ""] = s.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Format integer minor units as a fixed 2-decimal string. */
export function fromMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Integer-only multiply of a minor amount by an integer quantity. */
export function mulMinor(minor: number, quantity: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 0) return null;
  const r = minor * quantity;
  return Number.isSafeInteger(r) ? r : null;
}
