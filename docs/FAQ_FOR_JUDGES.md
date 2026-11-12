# FAQ for judges

Short, honest answers. Where something is a prototype limit, it says so.

**1. Why not just prompt the agent to be careful?**
Because the same model that reads the invoice is the one being fooled. A forged footer can talk the model out of any instruction in its prompt. Purser puts the controls outside the model, in code that never reads the invoice: caps, allowlists, velocity, a kill switch, and a human for risky calls.

**2. How do you stop prompt injection?**
We don't try to detect it in the agent. We assume the agent can be tricked and limit what a tricked agent can do: every payment passes deterministic rules, payee trust checks and (if needed) a human, no matter what the agent was told. The AI reviewer itself treats the agent's text as untrusted data (delimited, never obeyed) and can only tighten a decision. Scenario A is exactly this attack.

**3. What if the AI reviewer is wrong?**
It can be wrong in two ways. If it is too cautious, a human clicks Approve (a cost, not a loss). If it misses an attack, the hard rules and trust checks have already run, and the reviewer cannot loosen them: the pipeline takes the strictest decision. The AI is a safety net, not the control.

**4. What happens when the LLM is down or rate limited?**
The call is escalated for a human (fail closed). Verdicts are cached, so an identical past input reuses its verdict; replay mode and the judge demo run purely from a shipped cache with no model at all. Rules, caps and the kill switch never need a model.

**5. Is this sandbox only?**
Yes. The server refuses any PayPal environment other than sandbox, and no live credentials exist anywhere in the project. Going live would need a review of every rule default and a threat model.

**6. How does it scale?**
It doesn't yet, and we say so. It is one Node process on SQLite, with rolling windows computed from the attempts table. That is fine for a team's agents; at higher volume you would move to a networked database and shard by agent. The design (stateless pipeline, a single decision function) makes that possible, but it is not built.

**7. What is the business model?**
Not part of this submission. A plausible one is per-agent or per-decision pricing for teams giving agents spending power, with the audit trail and reconciliation as the paid value. We have not validated pricing.

**8. Why PayPal MCP plus Payouts?**
The PayPal MCP server gives agents refunds, invoices, orders and read tools in one standard protocol, so Purser can sit in front of it as an MCP gateway with one config line. It has no payout tool, so vendor payouts use the Payouts REST API directly. Together they cover the money-moving actions an AP-style agent needs.

**9. Why a gateway rather than an SDK in the agent?**
A gateway works with any MCP client without changing the agent's code, and the agent cannot skip it: the only credentials it holds are Purser's, not PayPal's. An in-agent SDK would be controlled by the thing we are trying to constrain.

**10. Can the agent see the limits and probe them?**
No. Responses to the agent never reveal thresholds or allowlists; it gets a generic "blocked by spending policy" message. The operator sees the full reason in the dashboard. (A patient attacker could still learn limits by trial and error, which is why the velocity rule, structuring detection and the circuit breaker exist.)

**11. What does reconciliation add if the gateway already decides?**
The gateway only sees what passes through it. If a PayPal credential leaks or something bypasses Purser, money can move outside it. Reconciliation compares PayPal's signed webhooks and Transaction Search with Purser's ledger and flags `unrecorded_movement`, `amount_mismatch`, `duplicate` and `payout_denied_or_unclaimed`. On the hosted demo a real payout produced a real signed webhook that verified and matched its ledger row.

**12. Is the live demo using real money?**
It uses PayPal sandbox money, which is fake. "Try the demo" does not even touch the sandbox: each visitor gets a private, in-memory copy with simulated PayPal and cached AI verdicts, and a server-side allowlist (403 for anything else) keeps it away from the real system. The admin token gives full access to the real sandbox flow.

**13. What are the false positives?**
Anything above the approval threshold, a first-time payee, or a look-alike-ish address is held for a human. A vendor whose address genuinely changed would be held until approved, by design. The policy lets you tune thresholds and the allowlist; we have not measured a false-positive rate on real traffic.

**14. What is production-ready and what is a prototype?**
Solid: the rule engine and pipeline (pure code, 565 automated tests across the project), idempotent execution, exactly-once approvals, webhook signature verification, secret scanning. Prototype: single-process SQLite, one admin token (no users or roles), ephemeral hosting on Render's free plan, heuristic look-alike detection, a policy compiler limited to what the policy schema can express, web-only approvals, and a sandbox-only PayPal integration.

**15. What did AI (and Claude Code) actually do here?**
At runtime, Groq's `openai/gpt-oss-120b` is used for three things: the payment reviewer (tighten-only), the plain-English policy compiler (proposals only, you apply), and an optional live demo agent. The project itself was built with Claude Code from a written spec and a sequence of prompts, with tests and a secret scanner gating every commit.
