# Devpost submission checklist

Everything you must fill in, in the order Devpost asks, with text ready to paste. Tick each box. Items marked **YOU** need a manual action. Nothing in this file is a secret; where a secret belongs it says so.

## 0. Before you touch Devpost

- [ ] **YOU: make the GitHub repo public** (GitHub > repo > Settings > General > Danger Zone > Change visibility > Public). Do this only after the safety report in the final message says it is safe. The footer link on the landing page (`https://github.com/Im-2/purser`) points here.
- [ ] Open the repo in a private window and confirm the **MIT License** badge shows in the right sidebar and `LICENSE` is visible.
- [ ] Open the live site in a private window: `https://purser-pf93.onrender.com/` then **Open the dashboard**, then **Try the demo**. Run scenario A. (First load after idle can take up to a minute.)
- [ ] **YOU: record the video** following `docs/DEMO_SCRIPT.md` (under 3:00, English, no third-party music), upload it to **YouTube as Public** (or Unlisted if allowed), and copy the link.
- [ ] Choose 3 to 5 screenshots from `docs/screens/` for the gallery (suggested: `landing-1440-1-hero.png`, `landing-1440-pipeline-2.png`, `05-attack-lab-A.png`, `06-approvals.png`, `18-reconciliation-run-1440.png`).

## 1. Project name

```
Purser
```

## 2. Tagline (Devpost limit: 60 characters)

```
Spending firewall for AI agents on PayPal
```

## 3. Short description / elevator pitch

```
Purser sits between an AI agent and PayPal and judges every payment: hard rules, payee trust checks, an AI reviewer that can only tighten, then a human. It stops the forged invoice, the runaway loop and the split payment before any money moves.
```

## 4. Project story (the long "About the project" field)

Paste everything between the lines. Devpost renders Markdown headings.

---

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

---

## 5. Built with (tags)

Paste these as separate tags:

```
typescript, nodejs, fastify, sqlite, react, vite, tailwindcss, ag-grid, paypal, paypal-payouts-api, paypal-mcp, model-context-protocol, groq, gpt-oss-120b, render, zod, vitest, playwright, claude-code
```

## 6. "Try it out" links

- [ ] **Live demo:** `https://purser-pf93.onrender.com/`
- [ ] **GitHub repository:** `https://github.com/Im-2/purser` (must be public)
- [ ] **Demo video (YouTube):** *paste your link*

## 7. Testing instructions (the private field for judges)

```
No account or token is needed.

1. Open https://purser-pf93.onrender.com/ and click "Open the dashboard" (or go to /app). The first load can take up to a minute: the free Render instance sleeps when idle.
2. On the sign-in screen click "Try the demo". This opens a private, one-hour, replay-only session: PayPal is simulated, the AI answers from a cache, and nothing you do affects anyone else or any real account.
3. In Attack Lab you land on scenario A. Press "Run scenario A" (the poisoned invoice is held), then open Approvals and press Deny. Then run D (allowed), B (structuring is blocked) and C (a runaway loop is blocked and the agent frozen). Click any row on the Live page for the full explanation, and try the Kill switch.
4. Optional full access (live LLM agents, plain-English policy compile and apply, real PayPal sandbox payouts and webhooks): sign in with the admin token instead.
   Admin token: <PASTE THE ADMIN TOKEN HERE IN THE DEVPOST FIELD ONLY. Never commit it. Rotate it after judging.>

Policy compile/apply and reconciliation "Run now" are disabled in demo mode because they call the model and PayPal; the server returns 403 for them.
```

- [ ] **YOU:** replace the `<PASTE ...>` line with the real admin token (from your `.env`, `PURSER_ADMIN_TOKEN`) in the Devpost field. After judging, rotate it in Render (Environment > `PURSER_ADMIN_TOKEN`) and redeploy.

## 8. Other fields

- [ ] **Team members:** add yourself (and anyone else who must be listed).
- [ ] **Challenge / prize categories:** select the PayPal AI hackathon track(s) you are entering.
- [ ] **Image gallery:** upload the 3 to 5 screenshots from section 0. Add a thumbnail (landing hero works).
- [ ] **Video:** the YouTube link in section 6 (public, under 3:00, English, no third-party music).
- [ ] **Open source / license:** the repo is public and shows the MIT license.
- [ ] **Anything the form asks about third-party tools:** PayPal (Payouts, Webhooks, Orders, Transaction Search, MCP server), Groq (`openai/gpt-oss-120b`), Render, AG Grid Community, the MCP SDK. All listed in the project story above.

## 9. Final checks before pressing Submit

- [ ] Reload the live site once, and run Try the demo > scenario A.
- [ ] Open the GitHub repo in a private window: README renders, the diagram shows, the license is detected.
- [ ] The video plays while logged out.
- [ ] No secret in any field you pasted (the only secret-shaped item is the optional admin token, in the private testing field).
- [ ] Submit, then re-open the public project page and click every link once.
