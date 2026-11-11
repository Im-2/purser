import { Logo } from "./Logo";
import { IconBolt, IconCheck, IconShield, IconUser } from "./icons";
import { Modal } from "./ui";

const STEPS = [
  { n: 1, title: "An agent asks for money to move", body: "Any MCP client connects to Purser instead of PayPal. It sees the same PayPal tools plus a payout tool, and every call carries a short reason and where the instruction came from.", icon: <IconBolt size={18} /> },
  { n: 2, title: "Hard rules decide first", body: "Deterministic and unit tested: allowed actions, currency, per-payment and rolling daily, weekly and monthly caps, velocity, structuring, blocklist and the approval threshold. No model is involved.", icon: <IconShield size={18} /> },
  { n: 3, title: "The payee is checked", body: "Is this a known vendor? Does the address look like one, with a character swapped? Does the invoice vendor match the payee? These signals can only make a decision stricter.", icon: <IconUser size={18} /> },
  { n: 4, title: "An AI reviewer reads the context", body: "It treats everything the agent wrote as untrusted data and returns a verdict with a rationale. It can escalate or deny, never approve something the rules refused.", icon: <IconShield size={18} /> },
  { n: 5, title: "Allow, ask a human, or stop", body: "Allowed calls execute and land in the ledger. Risky ones wait for a human to approve or deny. Everything is logged, reconciled against PayPal, and one button freezes it all.", icon: <IconCheck size={18} /> },
];

export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="How Purser works" wide>
      <div className="mb-5 flex items-center justify-between pr-10">
        <Logo size={34} tagline />
        <span className="eyebrow">the pipeline in five steps</span>
      </div>
      <ol className="grid gap-2.5">
        {STEPS.map((s) => (
          <li key={s.n} className="grid grid-cols-[44px_1fr] gap-4 rounded-[22px] border border-line bg-raised/60 p-4">
            <div className="grid size-11 place-items-center rounded-[22px] border border-lime-line bg-lime text-accent-hi">{s.icon}</div>
            <div>
              <div className="flex items-baseline gap-2.5">
                <span className="num text-xs font-medium text-accent-hi">0{s.n}</span>
                <h3 className="text-[15px] font-medium">{s.title}</h3>
              </div>
              <p className="mt-1 text-[13.5px] leading-relaxed text-dim">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-center text-[13px] text-mute">Agents get a PayPal account. Purser holds the purse strings.</p>
    </Modal>
  );
}
