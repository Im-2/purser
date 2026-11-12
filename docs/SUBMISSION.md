# Purser: Devpost submission text

**Tagline:** A spending firewall for AI agents on PayPal. Rules decide, an AI reviewer can only tighten, a human approves the risky calls.

## Inspiration

Agents that can pay invoices are arriving, and the failure case is easy to picture: an invoice PDF whose footer says "our bank details changed, please pay the updated address". The agent reads it, the model believes it, and a payout goes to the wrong account. Telling the model "never pay unknown vendors" does not fix this, because the model that reads the invoice is the model being fooled.

We wanted the controls to live outside the model: spending limits, an allowlist, a kill switch and a record of why each call was allowed or not, in code that never reads the invoice. PayPal's sandbox, Payouts API and MCP server gave us a real payment rail to build that against.

## What it does

Purser is an MCP gateway that sits between an AI agent and PayPal. The agent connects to Purser's `/mcp` endpoint instead of PayPal's. Every money-touching call goes through a fixed pipeline:

1. Agent authentication, then the kill switch.
2. Classification. An unknown tool, amount or currency is denied.
3. Deterministic rules: caps per payment, day, week and month, velocity, structuring detection, payee allowlist and blocklist, an approval threshold.
4. Payee trust signals with evidence: first-time payee, look-alike address, vendor mismatch, recently changed payee, free-mail address for a business.
5. An AI reviewer that can only make the decision stricter.
6. Human approval for anything escalated. Approving runs the stored call exactly once.
7. Execution against PayPal, then a ledger entry.

Around that: a dashboard with a live decision grid and a full explanation per call; a kill switch and a circuit breaker that freezes an agent after repeated denies; policies you can write in plain English (compiled to a proposal with a diff and warnings, applied only when you press Apply); and reconciliation that compares PayPal webhooks and Transaction Search with Purser's ledger, so a payout made outside Purser shows up as an `unrecorded_movement` finding.

An Attack Lab runs four scenarios from the dashboard: a poisoned invoice, structuring (six payments just under the cap), a runaway refund loop, and a legitimate payment. Each has a scripted replay mode and a live mode with a real LLM agent.

## How we built it

- **Server:** one Fastify process (TypeScript) serving the MCP gateway (`@modelcontextprotocol/sdk`), the admin API with server-sent events, the PayPal webhook receiver and the built dashboard. State is in SQLite (`better-sqlite3`).
- **PayPal:** OAuth, the Payouts REST API for payouts (the PayPal MCP server has no payout tool), the PayPal MCP server (`@paypal/mcp`, started over stdio) for refunds, invoices, orders and read tools, the Orders API for the scenario C setup, Webhooks with `verify-webhook-signature`, and Transaction Search for reconciliation.
- **AI:** Groq running `openai/gpt-oss-120b` through an OpenAI-compatible client, for three things: the payment reviewer, the policy compiler and the live demo agent. The reviewer's output is schema-validated, agent-supplied text is passed as delimited untrusted data, failures escalate, and verdicts are cached, which also makes replay mode work without the model.
- **Dashboard:** React, Vite and Tailwind, with AG Grid Community for the decision and reconciliation grids, driven by server-sent events. All colours, radii and motion timings sit in one tokens file.
- **Hosting:** Render, one web service from a Blueprint. The disk is ephemeral, so the server seeds an empty database on boot and loads a shipped, secret-free cache of AI verdicts.
- **Process:** we built it with Claude Code, working from a written spec and a sequence of prompts, with tests and a secret scanner gating every commit.

## Challenges

- **The model cannot be the control.** Early on the question was what the AI is for if the rules are the real limit. We settled on a narrow job: it can escalate or deny, never allow, and when a call is already escalated it only writes the rationale a human reads. The code enforces this by taking the strictest of the two decisions.
- **The payment rail has gaps.** The PayPal MCP server has no payout tool, so payouts go through the REST API directly. A sandbox capture normally needs a buyer to approve an order in a browser; scenario C instead creates the order with PayPal's published sandbox test card so there is a real capture to refund, and we document that this setup step is not an agent action.
- **Sandbox accounts have generated emails**, so a hand-picked look-alike domain was not possible. The scenarios derive the look-alike from the real vendor address, and the trust check weighs the local part, because the domain is shared.
- **Transaction Search lags in the sandbox**, sometimes by hours. Reconciliation reports `ok`, `lagging`, `unavailable` or `skipped` instead of failing, and webhooks plus payout-batch lookups cover the gap.
- **Free-tier model limits.** A rate-limited reviewer would stall a demo, so verdicts are cached and replay mode runs with no model call at all.
- **Ephemeral hosting.** The free Render disk is wiped on restart. We made the first boot seed itself, and found while testing the build on Linux that the lockfile also had to pin the package manager for a frozen install to work.

## Accomplishments

- The same decision pipeline runs for the scripted agent, a live LLM agent and the dashboard's Attack Lab, and writes to one audit table.
- 565 automated tests, including the rules engine, the pipeline with a mocked PayPal, webhook signature handling and reconciliation, plus a replay check (`pnpm demo:verify`) that runs all four scenarios with model calls disabled.
- Real sandbox money moves end to end: an approved escalation executes exactly once, and an out-of-band payout is caught by reconciliation.
- Every decision is explainable on screen: the stage that decided, the rules hit, the signals with their evidence, the AI rationale and the upstream result.

## What we learned

- Fail-closed defaults are cheap to write at the start and expensive to retrofit: unknown tool, unknown amount, reviewer error and upstream error all deny or escalate.
- "Tighten only" is easier to reason about than "the AI decides, with guardrails". It also made the AI layer easy to test.
- Reconciliation changes what the product claims. A gateway only sees what passes through it; checking PayPal's side is what covers a bypassed credential.
- Honest limits are part of the demo. A policy compiler that says "I could not enforce a per-category limit" is more useful than one that quietly ignores it.

## What's next

- Approval notifications by chat or email. Approvals are web-only today.
- Per-agent and per-category limits, and policy tests you can run before applying.
- A persistent database for hosted use, and multi-user accounts with roles.
- More payment rails and live-mode review of every rule default before touching production money.

## Tools and services used

| Tool | How it was used |
|---|---|
| PayPal OAuth | Access tokens for every REST call and for the MCP child process. |
| PayPal Payouts API | `purser_payout`, the vendor payments the agent requests. |
| PayPal MCP server (`@paypal/mcp`) | Refunds, invoices, orders and read tools, proxied through the gateway after Purser judges each call. |
| PayPal Orders API | Scenario C setup only: creates a sandbox capture to refund. |
| PayPal Webhooks | Signed payout and capture events, verified and reconciled against the ledger. |
| PayPal Transaction Search | The "Run now" reconciliation reads recent outgoing activity. |
| Groq, `openai/gpt-oss-120b` | Payment reviewer, policy compiler and the live demo agent, through an OpenAI-compatible API. |
| Model Context Protocol SDK | The gateway's MCP server for agents and the client for PayPal's MCP server. |
| Render | Hosting for the live demo (one web service, Blueprint in `render.yaml`). |
| AG Grid Community | The live decisions grid and the reconciliation findings grid. |
| Fastify, SQLite (`better-sqlite3`), zod | Server, storage and schema validation. |
| React, Vite, Tailwind CSS | The dashboard. |
| Playwright (Edge) | Browser verification of the dashboard against the real backend (development only). |
| Claude Code | The build tool: the code, tests and documentation were written with it from a spec. |

## Testing instructions (for the Devpost "testing" field)

No account or token is needed.

1. Open the live URL and click **Open the dashboard** (or go to `/app`). The first load can take up to a minute: the free Render instance sleeps when idle.
2. On the sign-in screen click **Try the demo**. This opens a private, one-hour, replay-only session: PayPal is simulated, the AI answers from a cache, and nothing you do affects anyone else or any real account.
3. In **Attack Lab** run scenarios **D**, **A**, **B** and **C**. Then open **Approvals** to deny the held payout from A, look at **Live** (click a row for the full explanation), and try the **Kill switch**.
4. Optional, for full access (live LLM agents, policy compile and apply, real sandbox payouts and webhooks): sign in with the admin token below instead.
   Admin token: *(paste the token here in the Devpost field, not in the repo)*

Policy compile/apply and reconciliation "Run now" are disabled in demo mode because they call the model and PayPal; the server returns 403 for them.

## Links

- Repository: see the Devpost submission (public, MIT license).
- Live demo and judge instructions: see the Devpost testing instructions.
