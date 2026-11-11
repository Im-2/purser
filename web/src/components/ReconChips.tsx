import type { ReconFinding } from "../lib/types";

export type RowKind = "matched" | "unrecorded_movement" | "amount_mismatch" | "duplicate" | "payout_denied_or_unclaimed" | "noted";

export const KIND_LABEL: Record<RowKind, string> = {
  matched: "matched",
  unrecorded_movement: "unrecorded movement",
  amount_mismatch: "amount mismatch",
  duplicate: "duplicate",
  payout_denied_or_unclaimed: "payout denied or unclaimed",
  noted: "noted",
};

/** Finding chips reuse the decision palette on purpose: green is fine, amber needs a look, red is money that moved unexpectedly. */
const KIND_CLS: Record<RowKind, string> = {
  matched: "border-allow-line bg-allow-soft text-allow",
  unrecorded_movement: "border-deny-line bg-deny-soft text-deny",
  amount_mismatch: "border-escalate-line bg-escalate-soft text-escalate",
  duplicate: "border-line-strong bg-sunken text-dim",
  payout_denied_or_unclaimed: "border-escalate-line bg-escalate-soft text-escalate",
  noted: "border-line-strong bg-sunken text-mute",
};

export const kindOf = (f: ReconFinding): RowKind => (f.matched ? "matched" : (f.finding_type ?? "noted"));

export function TypeChip({ kind }: { kind: RowKind }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${KIND_CLS[kind]}`}>{KIND_LABEL[kind]}</span>;
}
