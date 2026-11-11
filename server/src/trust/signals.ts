import type { Policy, TrustSignal as TrustSignalId } from "@purser/shared";
import { damerauLevenshtein, skeleton, splitEmail } from "./lookalike.js";

/**
 * Stage 3 payee trust (SPEC section 4). Deterministic: no network, no model. Never loosens a decision; it only adds
 * signals that may escalate or deny. Sandbox accounts share one email domain, so the local part carries the signal.
 */

export interface KnownPayee {
  email: string;
  display_name: string | null;
}

export interface TrustInput {
  payeeEmail: string;
  knownPayees: KnownPayee[];
  /** Agent-supplied, untrusted. Used only for simple string comparison, never interpreted as instructions. */
  reason: string | null;
  source: string | null;
  args: Record<string, unknown>;
  policy: Pick<Policy, "trust" | "payees">;
}

export interface TrustSignal {
  id: TrustSignalId;
  severity: "info" | "escalate" | "deny";
  evidence: string;
}

export interface TrustResult {
  signals: TrustSignal[];
  /** Strictest decision implied by the signals, or undefined when they only inform. */
  decision?: "escalate" | "deny";
}

export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "qq.com",
]);

const BUSINESS_WORDS = /\b(inc|llc|ltd|corp|co|company|corporation|gmbh|plc|supplies|parts|industries|group|holdings|services|solutions|traders|partners|enterprises|logistics|wholesale)\b/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const VENDOR_ARG_KEYS = ["vendor", "vendor_name", "supplier", "payee_name", "recipient_name", "invoice_vendor"];

const lc = (s: string) => s.trim().toLowerCase();

function declaredVendorNames(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const grab = (o: Record<string, unknown>) => {
    for (const k of VENDOR_ARG_KEYS) if (typeof o[k] === "string" && o[k].trim()) out.push(o[k].trim());
  };
  grab(args);
  if (typeof args.invoice === "object" && args.invoice !== null) grab(args.invoice as Record<string, unknown>);
  return out;
}

function brandToken(name: string): string | null {
  const t = name.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4)[0];
  return t ?? null;
}

export function computeTrustSignals(input: TrustInput): TrustResult {
  const payee = splitEmail(input.payeeEmail);
  if (!payee) return { signals: [] };
  const payeeEmail = lc(input.payeeEmail);

  // Known payees = the payee table plus anything on the policy allowlist.
  const known = new Map<string, KnownPayee>();
  for (const k of input.knownPayees) known.set(lc(k.email), { email: lc(k.email), display_name: k.display_name });
  for (const a of input.policy.payees.allowlist) if (!known.has(lc(a))) known.set(lc(a), { email: lc(a), display_name: null });
  const exact = known.get(payeeEmail);

  const signals: TrustSignal[] = [];
  const text = `${input.reason ?? ""} ${input.source ?? ""}`.toLowerCase();

  if (!exact) signals.push({ id: "first_time_payee", severity: "info", evidence: `${payeeEmail} has not been paid before` });

  // --- lookalike_payee ---
  if (!exact) {
    let best: { evidence: string; score: number } | null = null;
    for (const k of known.values()) {
      const kp = splitEmail(k.email);
      if (!kp) continue;
      const sameDomain = kp.domain === payee.domain;
      const domainClose = !sameDomain && (damerauLevenshtein(kp.domain, payee.domain) <= 2 || skeleton(kp.domain) === skeleton(payee.domain));
      if (!sameDomain && !domainClose) continue;

      const localDist = damerauLevenshtein(payee.local, kp.local);
      const localSkeletonEq = kp.local.length >= 3 && payee.local !== kp.local && skeleton(payee.local) === skeleton(kp.local);
      const maxDist = kp.local.length >= 12 ? 2 : 1;
      const localClose = kp.local.length >= 4 && payee.local !== kp.local && localDist <= maxDist;
      const domainTypo = domainClose && payee.local === kp.local;

      if (localSkeletonEq || localClose || domainTypo) {
        const evidence = domainTypo
          ? `domain "${payee.domain}" imitates "${kp.domain}" for the same mailbox name as known payee ${k.email}`
          : `local part "${payee.local}" is ${Math.max(localDist, 1)} edit${localDist > 1 ? "s" : ""} (or a look-alike spelling) from known payee ${k.email}`;
        const score = domainTypo ? damerauLevenshtein(kp.domain, payee.domain) : localDist;
        if (!best || score < best.score) best = { evidence, score };
      }
    }
    if (best) signals.push({ id: "lookalike_payee", severity: input.policy.trust.lookalike, evidence: best.evidence });
  }

  // --- vendor_mismatch: simple extraction from the declared vendor, reason/source text and emails mentioned in it ---
  const mismatchNotes: string[] = [];
  let namedKnown: KnownPayee | undefined;
  for (const k of known.values()) {
    if (k.display_name && text.includes(k.display_name.toLowerCase())) {
      namedKnown = k;
      if (k.email !== payeeEmail) mismatchNotes.push(`the reason or source names "${k.display_name}" but the payee is ${payeeEmail}, not their known address ${k.email}`);
      break;
    }
  }
  const mentioned = new Set((text.match(EMAIL_IN_TEXT) ?? []).map(lc));
  for (const m of mentioned) {
    if (m !== payeeEmail && known.has(m)) mismatchNotes.push(`the reason or source refers to known address ${m} but the payee is ${payeeEmail}`);
  }
  for (const vendor of declaredVendorNames(input.args)) {
    const matched = [...known.values()].find((k) => k.display_name && (skeleton(k.display_name) === skeleton(vendor) || k.display_name.toLowerCase().includes(vendor.toLowerCase()) || vendor.toLowerCase().includes(k.display_name.toLowerCase())));
    if (matched) {
      namedKnown ??= matched;
      if (matched.email !== payeeEmail) mismatchNotes.push(`the invoice vendor "${vendor}" is known as ${matched.email}, not ${payeeEmail}`);
    } else {
      const tokens = vendor.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      const haystack = `${payee.local} ${payee.domain}`;
      if (tokens.length && !tokens.some((t) => haystack.includes(t))) mismatchNotes.push(`the invoice vendor "${vendor}" does not match the payee ${payeeEmail}`);
    }
  }
  if (mismatchNotes.length) signals.push({ id: "vendor_mismatch", severity: input.policy.trust.vendor_mismatch, evidence: mismatchNotes[0]! });

  // --- payee_recently_changed: a known vendor now appears under an address we have not seen ---
  if (!exact) {
    const brandHit = [...known.values()].find((k) => {
      const brand = k.display_name ? brandToken(k.display_name) : null;
      return brand !== null && k.email !== payeeEmail && payee.local.includes(brand);
    });
    const vendor = namedKnown ?? brandHit;
    if (vendor && vendor.email !== payeeEmail) {
      signals.push({ id: "payee_recently_changed", severity: "escalate", evidence: `known vendor ${vendor.display_name ?? vendor.email} is now being paid at a different address (${payeeEmail})` });
    }
  }

  // --- free_mail_for_business: a business-named vendor paid at a consumer mailbox ---
  if (!exact && FREE_MAIL_DOMAINS.has(payee.domain)) {
    const names = [...declaredVendorNames(input.args), namedKnown?.display_name ?? "", ...[...known.values()].filter((k) => k.display_name && text.includes(k.display_name.toLowerCase())).map((k) => k.display_name!)];
    const business = names.find((n) => n && BUSINESS_WORDS.test(n));
    if (business) signals.push({ id: "free_mail_for_business", severity: input.policy.trust.free_mail_for_business, evidence: `"${business}" looks like a business but the payee is at the free-mail domain ${payee.domain}` });
  }

  const decision = signals.some((s) => s.severity === "deny") ? "deny" : signals.some((s) => s.severity === "escalate") ? "escalate" : undefined;
  return { signals, decision };
}
