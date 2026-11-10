import { mulMinor, toMinor } from "../money.js";

export interface Extracted {
  /** Integer minor units, or null if it cannot be determined exactly (callers fail closed). */
  amountMinor: number | null;
  currency: string | null;
  payeeEmail: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const cur = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = (v: unknown): string | null => {
  const s = str(v);
  return s && EMAIL.test(s) ? s.toLowerCase() : null;
};

/** Parse an amount that may be number | "12.50" | {value, currency_code|currency}. Positive only. */
function money(v: unknown): { minor: number | null; currency: string | null } {
  if (isObj(v)) {
    const minor = toMinor(v.value ?? v.amount);
    return { minor: minor && minor > 0 ? minor : null, currency: cur(v.currency_code ?? v.currency) };
  }
  const minor = toMinor(v);
  return { minor: minor && minor > 0 ? minor : null, currency: null };
}

function firstEmail(...vals: unknown[]): string | null {
  for (const v of vals) {
    const e = email(v);
    if (e) return e;
  }
  return null;
}

/** Sum line items (unit amount x quantity) plus optional shipping and tax. Null if any item is unparseable. */
function sumItems(items: unknown, extra: unknown[]): { minor: number | null; currency: string | null } {
  if (!Array.isArray(items) || items.length === 0) return { minor: null, currency: null };
  let total = 0;
  let currency: string | null = null;
  for (const it of items) {
    if (!isObj(it)) return { minor: null, currency: null };
    const unit = money(it.unit_amount ?? it.price ?? it.amount ?? it.unit_price);
    if (unit.minor === null) return { minor: null, currency: null };
    const q = it.quantity === undefined ? 1 : Number(it.quantity);
    const line = mulMinor(unit.minor, q);
    if (line === null) return { minor: null, currency: null };
    total += line;
    currency = currency ?? unit.currency ?? cur(it.currency_code ?? it.currency);
  }
  for (const e of extra) {
    if (e === undefined || e === null) continue;
    const m = money(e);
    if (m.minor === null) return { minor: null, currency: null };
    total += m.minor;
  }
  return Number.isSafeInteger(total) && total > 0 ? { minor: total, currency } : { minor: null, currency: null };
}

/** Extract amount, currency and payee from a tool call's arguments. Shapes follow PayPal MCP and Purser native tools. */
export function extractCall(tool: string, args: unknown): Extracted {
  const a: Obj = isObj(args) ? args : {};
  const empty: Extracted = { amountMinor: null, currency: cur(a.currency_code ?? a.currency), payeeEmail: null };

  switch (tool) {
    case "create_order": {
      // Prefer the sum of items; fall back to an explicit amount / purchase_units[0].amount.
      const unit0 = Array.isArray(a.purchase_units) && isObj(a.purchase_units[0]) ? (a.purchase_units[0] as Obj) : undefined;
      const items = a.items ?? unit0?.items;
      const summed = sumItems(items, [a.shipping_amount ?? a.shipping, a.tax_amount ?? a.tax]);
      if (summed.minor !== null) {
        return { amountMinor: summed.minor, currency: summed.currency ?? empty.currency, payeeEmail: firstEmail(a.payee_email, isObj(unit0?.payee) ? (unit0?.payee as Obj).email_address : null) };
      }
      const explicit = money(a.amount ?? unit0?.amount);
      return { amountMinor: explicit.minor, currency: explicit.currency ?? empty.currency, payeeEmail: firstEmail(a.payee_email) };
    }
    case "create_invoice": {
      const inv = isObj(a.invoice) ? (a.invoice as Obj) : a;
      const items = inv.items ?? a.items;
      const summed = sumItems(items, [inv.shipping_amount, inv.tax_amount]);
      const recip = Array.isArray(inv.primary_recipients) && isObj(inv.primary_recipients[0]) ? (inv.primary_recipients[0] as Obj) : undefined;
      const billing = isObj(recip?.billing_info) ? (recip?.billing_info as Obj) : undefined;
      const payee = firstEmail(billing?.email_address, a.recipient_email, a.recipient);
      if (summed.minor !== null) return { amountMinor: summed.minor, currency: summed.currency ?? empty.currency, payeeEmail: payee };
      const explicit = money(inv.amount ?? a.amount);
      return { amountMinor: explicit.minor, currency: explicit.currency ?? empty.currency, payeeEmail: payee };
    }
    case "create_refund": {
      // Missing amount means "full refund": unknown here, the caller must look it up (and escalate if that fails).
      const m = money(a.amount);
      return { amountMinor: m.minor, currency: m.currency ?? empty.currency, payeeEmail: firstEmail(a.payer_email, a.recipient_email) };
    }
    case "purser_payout": {
      const m = money(a.amount ?? a.value);
      return {
        amountMinor: m.minor,
        currency: m.currency ?? empty.currency,
        payeeEmail: firstEmail(a.recipient_email, a.payee_email, a.receiver, a.email, a.recipient),
      };
    }
    case "pay_order":
    case "capture_order": {
      const m = money(a.amount);
      return { amountMinor: m.minor, currency: m.currency ?? empty.currency, payeeEmail: firstEmail(a.payee_email) };
    }
    default: {
      // Generic best effort for other tools (create_subscription*, create_product, refund-like names...).
      const m = money(a.amount ?? a.value ?? a.price);
      return { amountMinor: m.minor, currency: m.currency ?? empty.currency, payeeEmail: firstEmail(a.recipient_email, a.payee_email, a.receiver, a.email) };
    }
  }
}
