import { IconChevronRight, IconShield } from "../components/icons";
import { navigate } from "../lib/route";

const COPY = {
  policies: {
    title: "Policies",
    lead: "Write the rules in plain English and see exactly what changes before you apply them.",
    items: ["A text box that compiles your sentence into a policy", "A preview with a field-by-field diff and amber warnings", "Version history and a raw JSON view"],
  },
  reconciliation: {
    title: "Reconciliation",
    lead: "Check PayPal's view against Purser's ledger and catch money that moved without approval.",
    items: ["A live table of findings with type chips", "A Run now button for an on-demand check", "New findings highlighted the moment a webhook lands"],
  },
} as const;

export function ComingNextPage({ which }: { which: keyof typeof COPY }) {
  const c = COPY[which];
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <div className="panel relative overflow-hidden p-8 sm:p-10">
        <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-accent/10 blur-3xl" />
        <span className="inline-flex items-center gap-2 rounded-full border border-accent/50 bg-accent/12 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-accent-hi">
          <span className="size-1.5 rounded-full bg-accent-hi" /> Coming next
        </span>
        <div className="mt-5 flex items-center gap-4">
          <div className="grid size-12 place-items-center rounded-xl border border-line-strong bg-raised text-accent-hi">
            <IconShield size={22} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
        </div>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-dim">{c.lead}</p>
        <ul className="mt-5 space-y-2.5">
          {c.items.map((i) => (
            <li key={i} className="flex items-start gap-3 text-sm text-fg/85">
              <IconChevronRight size={15} className="mt-0.5 shrink-0 text-accent-hi" />
              {i}
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[13px] text-mute">This page is part of the next build step. The API behind it already exists.</p>
        <button onClick={() => navigate("live")} className="focus-ring mt-6 rounded-lg border border-line-strong px-4 py-2 text-sm font-semibold text-fg transition hover:bg-hover">
          Back to Live
        </button>
      </div>
    </main>
  );
}
