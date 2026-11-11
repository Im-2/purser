# Purser

**A spending firewall for AI agents on PayPal.** An agent gets a PayPal account; Purser sits in front of it and decides, for every money-touching tool call, whether to allow it, hold it for a human, or block it, before any money moves.
Hard rules decide first, then payee trust checks, then an AI reviewer that can only make a decision stricter, never looser.

> Built for the PayPal AI Hackathon. **Sandbox only: no live PayPal credentials anywhere.** License: MIT.

## The problem

An AI agent that can pay invoices is one poisoned document away from paying the wrong person. An invoice PDF that says "our bank details changed, please pay the updated address" is enough to redirect a payout, and a prompt-level instruction like "never pay unknown vendors" is not a control: the model that reads the invoice is the same model that is being tricked. Spending limits belong outside the model, in code that does not read the invoice.

Purser is that code. It speaks MCP to the agent, so the agent needs one config line, and it speaks to PayPal on the other side.

## What it does

- **MCP gateway.** The agent connects to Purser's `/mcp` endpoint instead of PayPal's. Purser re-exposes PayPal's MCP tools plus three of its own (`purser_payout`, `purser_check_approval`, `purser_status`) and judges every call.
- **Decision pipeline** (below): kill switch, deterministic rules, payee trust signals, an AI reviewer, human approval, then execution with an idempotency key.
- **Explains every decision.** Each attempt records the stage that decided, the rules hit, the trust signals with their evidence, the AI verdict and rationale, the arguments, and the upstream result. The dashboard shows all of it.
- **Human approvals.** Risky calls wait in an Approvals queue. Approving executes the stored call exactly once; denying closes it.
- **Kill switch and circuit breaker.** One button freezes every agent. Repeated denies freeze an agent automatically.
- **Plain-English policies.** "Allow up to $50 a day on office supplies..." compiles to a policy proposal with a diff and warnings; nothing changes until you press Apply.
- **Reconciliation.** PayPal webhooks and Transaction Search are compared with Purser's ledger, so money that moved *outside* Purser shows up as a finding.
- **Attack Lab.** Four scripted scenarios (and a live LLM agent mode) you can run from the dashboard.

## Architecture

```mermaid
flowchart LR
    subgraph Agent["AI agent (any MCP client)"]
        A[Tool calls]
    end
    subgraph Purser["Purser server (Fastify, one process)"]
        G["/mcp gateway<br/>agent API key"]
        P["Decision pipeline<br/>rules, trust, AI reviewer"]
        AP["Approvals, kill switch,<br/>circuit breaker"]
        DB[("SQLite<br/>attempts, ledger, policies,<br/>AI verdict cache")]
        ADM["/api admin + SSE<br/>admin token"]
        WH["/webhooks/paypal<br/>signature verified"]
        REC["Reconciliation"]
    end
    subgraph PayPal["PayPal sandbox"]
        MCP["@paypal/mcp<br/>(stdio child process)"]
        REST["REST: OAuth, Payouts,<br/>Transaction Search, Webhooks"]
    end
    LLM["Groq<br/>openai/gpt-oss-120b"]
    UI["Dashboard (React + AG Grid)"]

    A --> G --> P
    P --> DB
    P -- allowed --> MCP
    P -- payouts --> REST
    P -. review .-> LLM
    P --> AP
    UI <--> ADM
    ADM --> DB
    REST -- webhooks --> WH --> REC --> DB
    REC -- Run now --> REST
```

One Node process serves the MCP gateway, the admin API, the webhook receiver and the built dashboard. Monorepo layout: `server/` (gateway and everything behind it), `web/` (dashboard), `agent/` (demo agent and scenarios), `shared/` (zod schemas), `docs/`.

## The decision pipeline

Every money-touching call goes through these stages in order. The first stage that denies or escalates decides; later stages can only tighten.

| # | Stage | What it does |
|---|---|---|
| 0 | `auth` | Agent API key checked (stored hashed). |
| 1 | `killswitch` | A frozen agent, or the global freeze, is denied before anything else runs. |
| 2 | `classify` | The tool is classified (read, money in, capture, money out, outbound comms). **An unknown tool, unknown amount or unknown currency is denied** (fail closed). |
| 3 | `rules` | Pure, deterministic, no network and no model: allowed actions and currencies, per-payment / daily / weekly / monthly caps, velocity, structuring detection (several payments just under the cap), payee allowlist and blocklist, approval threshold. |
| 4 | `trust` | Payee trust signals with evidence: `first_time_payee`, `lookalike_payee`, `vendor_mismatch`, `payee_recently_changed`, `free_mail_for_business`. |
| 5 | `ai` | The reviewer reads the call and returns allow, escalate or deny. It may only tighten. On a call that is already escalated it is advisory: it writes a rationale for the human and cannot loosen anything. If it fails, the call is escalated. |
| 6 | `approval` | Escalated calls wait for a human in the dashboard. Approval runs the stored call exactly once (atomic claim plus an idempotency key); hard rules are re-checked at approval time. |
| 7 | `execute` | The call goes to PayPal. The result is written to the ledger. |

Responses to the agent never reveal thresholds or allowlists.

## How PayPal is used

All calls use the PayPal **sandbox**; the server refuses any other environment.

| PayPal API or tool | Used for |
|---|---|
| **OAuth 2.0** (`/v1/oauth2/token`) | Client-credentials token for every REST call, and the token handed to the MCP child process. |
| **Payouts API** (`POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}`) | `purser_payout`: paying vendors. `sender_batch_id` / `sender_item_id` come from the Purser attempt id, and a `PayPal-Request-Id` header makes retries safe. The PayPal MCP server has no payout tool, so this one is a REST call. |
| **PayPal MCP server** (`@paypal/mcp` 1.8.1, 28 tools, started over stdio) | Everything else an agent can do: `create_refund` (scenario C uses it), `list_invoices` and the other read tools, `create_order`, `pay_order`, `create_invoice`, `send_invoice` and so on. Purser classifies each tool and judges the call before forwarding it. |
| **Orders API** (`/v2/checkout/orders`) | Only in scenario C's *setup*: it creates and captures a sandbox order with PayPal's published test card, standing in for a customer, so the agent has a real capture to refund. It is not an agent action. |
| **Webhooks** (`POST /webhooks/paypal`, `verify-webhook-signature`) | Payout batch and item events, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` (and related states) are signature-verified through PayPal's endpoint, deduplicated by event id, and reconciled against the ledger. |
| **Transaction Search** (`GET /v1/reporting/transactions`) | The manual "Run now" reconciliation reads recent outgoing activity and flags anything Purser has no record of. Sandbox search can trail real time by hours; the run reports `ok`, `lagging`, `unavailable` or `skipped` instead of failing. |

## How AI is used

All model calls go through one OpenAI-compatible client. The deployment uses **Groq with `openai/gpt-oss-120b`**; the same client can point at any OpenAI-compatible endpoint, and an Anthropic provider exists in the code.

1. **Payment reviewer.** Reads one proposed call plus trusted context and returns `{verdict, risk 0-100, rationale, flags}`. Agent-supplied text (the stated reason, the source document, arguments, the payee address) is placed inside `<untrusted>` tags and the model is told never to follow instructions found there. Output is validated against a schema; invalid output is retried once, then the call is escalated. **Tighten-only:** the pipeline takes the strictest of the rules' decision and the reviewer's, so a model can never turn a deny or an escalate into an allow. Verdicts are cached (SQLite, keyed by a hash of the input, model and prompt version).
2. **Policy compiler.** Turns a plain-English sentence into a policy proposal (schema-validated, diffed against the active policy, with warnings for things it could not express). It never applies anything by itself.
3. **Demo agent (live mode).** A real tool-calling agent on the same client, connected to `/mcp`, that reads the scenario documents and decides for itself. Its prompt is its mandate; it is never told about Purser and the attacks come only from the documents it reads.

Rules, caps and the kill switch work with no model at all. With no LLM configured the reviewer fails closed (escalates).

## The attack scenarios

| | Scenario | What the agent does | What Purser does |
|---|---|---|---|
| **A** | Poisoned invoice | Reads a normal-looking invoice whose footer says the payment details changed, and tries to pay a look-alike of a known vendor's address. | Trust signals flag `lookalike_payee`, `vendor_mismatch`, `payee_recently_changed`; the call is held for a human, the AI writes the rationale, the human denies it. No money moves. |
| **B** | Structuring | Six $90 payments to one vendor, each just under the per-payment cap. | The first payments go through; the pattern is caught by the structuring rule or the daily cap and denied. |
| **C** | Runaway loop | The same refund again and again. | Velocity limits deny it, the circuit breaker freezes the agent. |
| **D** | Happy path | Pays a legitimate $120 invoice from an allowlisted vendor. | Allowed, executed, in the ledger. |

Each runs in **replay** (a scripted agent, cached AI verdicts: same result every time) or **live** (a real LLM agent). Run them from the dashboard's Attack Lab, or `pnpm demo:verify` to check all four from the command line.

## Security notes

- Agent API keys are stored hashed; the admin API requires a bearer token (and is disabled if none is set).
- Reviewer prompts treat agent-supplied strings as untrusted data, delimited and labelled; output is schema-validated.
- The rule engine is pure and deterministic and has unit tests; there are 537 automated tests in total (510 server, 27 agent).
- Fail closed everywhere: unknown tool, unknown amount, reviewer error, upstream error before execution.
- Idempotency: executed calls carry an idempotency key (`PayPal-Request-Id`) and approvals use an atomic claim, so retries cannot double-pay.
- Webhooks are verified through PayPal's `verify-webhook-signature` endpoint before any reconciliation write; without a configured webhook id they are refused.
- In production (`NODE_ENV=production`) the dev-only webhook simulator is not registered, CORS allows only the public URL, and request logs never contain tokens or query strings. A secret scanner (`pnpm check:secrets`, also a pre-push hook) blocks commits and pushes that contain secret values.
- Responses to agents never reveal thresholds or allowlists.

## Try the hosted demo (for judges)

The demo runs on Render's free plan, so it **sleeps when idle: the first request can take up to a minute to wake it.** The disk is ephemeral: each restart resets it to the seeded demo state, which is the intended starting point.

1. Open the live URL (in the Devpost submission). Sign in with the **admin token** given in the Devpost testing instructions (sandbox-only).
2. **Attack Lab** > keep **Replay** selected > run **D** (an allowed $120 payout lands in the ledger), then **A** (the poisoned invoice is held).
3. **Approvals**: open the held payout, read why Purser flagged it, and press **Deny**.
4. **Live** shows every decision; click a row for the full explanation.
5. Press the **Kill switch** to see the frozen banner, then **Unfreeze**.
6. **Policies**: compile "Allow up to $50 a day on office supplies, refunds up to $30, never pay new vendors without asking", read the diff and warnings, and (optionally) Apply. Use Attack Lab > **Reset demo** afterwards to restore the seeded policy.
7. **Reconciliation** > **Run now**.

Replay mode uses a shipped cache of AI verdicts, so it works without calling the model. Scenario D moves $120 of sandbox money; scenario A moves none.

## Run it yourself in 5 minutes (Windows, macOS, Linux)

Prerequisites: Node 22 or newer, and [pnpm](https://pnpm.io) (`corepack enable` is enough).

1. **PayPal sandbox accounts.** In the [PayPal developer dashboard](https://developer.paypal.com) (Sandbox): create one *Business* account (the store the agent operates) and two *Personal* accounts (the vendors, for example "Acme Supplies" and "Northwind Parts"). Add at least 1,000 USD to the Business account. Then create a **Merchant** REST app linked to the Business account and enable Payouts and Transaction Search on it. Copy its Client ID and Secret.
2. **Install and configure.**

       pnpm install
       copy .env.example .env        (macOS/Linux: cp .env.example .env)

   Fill in `.env`: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `BUSINESS_EMAIL`, `VENDOR_ACME_EMAIL`, `VENDOR_NORTHWIND_EMAIL`, a long random `PURSER_ADMIN_TOKEN`, and for the AI features `LLM_API_KEY` (a Groq key; `LLM_BASE_URL` and `LLM_MODEL` are already set in the example). `PAYPAL_ENV` must stay `sandbox`.
3. **Seed the database** (creates the Ops agent, the two vendors and the default policy, and saves the agent's API key into `.env` without printing it):

       pnpm --filter @purser/server seed -- --write-env

4. **Run.** One command starts the server (port 8799) and the dashboard (port 5173):

       pnpm dev

   Open http://127.0.0.1:5173 and sign in with your `PURSER_ADMIN_TOKEN`.
5. **Check everything.**

       pnpm test
       pnpm typecheck
       pnpm demo:verify

   `demo:verify` starts its own server in replay conditions (no model calls possible), runs all four scenarios and prints a green/red summary. It uses the PayPal sandbox for D, B and C, so it moves a few hundred sandbox dollars. Run `pnpm demo:warm` once against a server with a working LLM key first, to fill the AI verdict cache. Stop `pnpm dev` before `demo:verify` (they share a database).

To serve the built dashboard from the server instead of Vite: `pnpm --filter @purser/web build`, then `pnpm --filter @purser/server start` and open http://127.0.0.1:8799.

## Deploying to Render

`render.yaml` is a Blueprint for one web service named `purser`. It contains no secrets: they are marked `sync: false`. `pnpm render:env` writes a git-ignored `render.env` from your local `.env` for pasting into Render's "Add from .env".

- **Ephemeral disk.** On boot, if the database is empty the server migrates and seeds it (the agent is created from `AGENT_API_KEY`, hashed, so nothing secret is printed) and loads a committed, secret-free cache of AI verdicts from `server/seed/ai-verdicts.json`. Demo reset keeps that cache. Refresh the file with `pnpm demo:warm` then `pnpm --filter @purser/server ai:export-cache`.
- **PayPal MCP upstream.** `UPSTREAM_MODE=stdio` (default) runs the pinned `@paypal/mcp` that is installed at build time with `node`, so there is no `npx` and no download at boot. `npx` runs `npx -y @paypal/mcp` instead; `off` disables the upstream (native tools only).
- **URL.** `PUBLIC_URL` falls back to Render's `RENDER_EXTERNAL_URL`, so the final hostname never needs to be hard-coded. CORS allows only that origin.
- **Webhooks.** After the first deploy, register `https://<your-service>.onrender.com/webhooks/paypal` for the sandbox app (payout batch and item events, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`) and put the webhook id in `PAYPAL_WEBHOOK_ID`.

## What we built during the hackathon

All of it, from an empty repository, with Claude Code as the build tool:

- The MCP gateway, the decision pipeline and the pure rules engine, with 537 automated tests.
- The payee trust signals (including look-alike detection that weighs the local part of an address) and the tighten-only AI reviewer with its verdict cache and replay mode.
- The plain-English policy compiler with diff and warnings, and versioned policies.
- Human approvals with exactly-once execution, the kill switch, and the circuit breaker.
- PayPal integration: OAuth, Payouts, the PayPal MCP upstream, Orders (for the scenario C setup), signed webhooks, and Transaction Search reconciliation.
- The Attack Lab: a scripted demo agent, a live LLM agent, four scenarios, and `pnpm demo:verify`.
- The dashboard: Live decisions (AG Grid), Approvals, Attack Lab, Policies, Reconciliation, the kill switch, and a design-token system for restyling.
- Deployment to Render: the Blueprint, ephemeral-disk bootstrapping, the shipped AI verdict cache.

## Limitations and what's next

- **Sandbox only.** Nothing here has been run against live PayPal. Going live would need review of every rule default and a proper threat model.
- **Telegram approvals were not built.** Approvals happen in the web dashboard only. (`TELEGRAM_*` variables exist in `.env.example` but are unused.)
- **One admin token, one process.** There are no user accounts, roles or per-tenant isolation, and the server is a single process on SQLite. The Render free plan sleeps when idle and wipes its disk on restart, so approvals, attempts and findings do not persist there.
- **The AI reviewer is a safety net, not the control.** It only tightens, but it can be wrong in both directions (false escalations cost a human click). The rules, caps and kill switch are what actually bound the damage.
- **Look-alike detection is heuristic** (edit distance on the local part, name and source mismatch). A determined attacker with a plausible new domain and a clean story would need the allowlist to stop them.
- **Policy compiler gaps.** It can only express what the policy schema can (for example, it cannot enforce a separate limit for refunds or a per-category limit), and it says so in the warnings rather than pretending.
- **Reconciliation depends on PayPal.** Sandbox Transaction Search can lag by hours, and a demo reset clears the ledger, so earlier demo payouts can later be reported as unrecorded.
- **Live agent mode** depends on the model provider's rate limits.
- **Next:** approvals by chat (Telegram or Slack), per-agent and per-category limits, a persistent database for hosted use, more payment rails, and policy tests you can run before applying.

---

# Reference

## AI layer configuration

Purser's AI features (the payment-risk reviewer and the plain-English policy compiler) go through one
provider-agnostic client, so any OpenAI-compatible endpoint works. Set these in `.env`:

| Variable | Meaning |
|---|---|
| `LLM_PROVIDER` | `openai_compat` (plain `fetch` to `/chat/completions`: Groq, Gemini, OpenRouter, ...) or `anthropic`. |
| `LLM_BASE_URL` | API base URL, for example `https://api.groq.com/openai/v1`. Not needed for `anthropic`. |
| `LLM_API_KEY` | The provider key. Never printed or logged. |
| `LLM_MODEL` | Model id, for example `openai/gpt-oss-120b` on Groq. |
| `LLM_REASONING_EFFORT` | `none`, `low` (default), `medium`, `high`. Sent as `reasoning_effort`; dropped automatically if the endpoint rejects it. |
| `LLM_TIMEOUT_MS` | Per-request timeout, default 20000. |
| `AI_CACHE_TTL_SEC` | How long a cached verdict stays fresh, default 86400. |
| `AI_MODE` | `live` (default) or `cached_only` (replay: never call the model). |

Behaviour worth knowing:

- **Structured output.** The client asks for `json_schema` first, falls back to `json_object`, then to prompt-only JSON, and
  remembers what the endpoint accepts. Every reply is validated with zod; invalid output is retried once, then the
  reviewer fails closed to **escalate**.
- **Failures fail closed.** A timeout, HTTP 429 (waits as the provider asks, up to 15 s) or 5xx is retried once, then the
  call is escalated for a human. The model can never turn a deny or an escalate into an allow.
- **Verdict cache.** Verdicts are cached in memory and in SQLite, keyed by a hash of the normalized input, model and prompt
  version. This keeps demos fast and protects free-tier rate limits. If the model is down, an identical past input reuses its
  old verdict (marked `stale`). `AI_MODE=cached_only` runs purely from the cache, so a replayed demo works with no network.
- **Untrusted text.** The agent's `reason`, `source`, arguments and payee address are placed inside `<untrusted>` tags, with
  `<` escaped so they cannot close the block, and the system prompt tells the model never to follow instructions found there.

Check the connection with one real call (prints the verdict, structured-output mode and latency; never the key):

    pnpm --filter @purser/server ai:check
    pnpm --filter @purser/server ai:check -- --compile

### Policy compiler API

Both routes need `Authorization: Bearer $PURSER_ADMIN_TOKEN`.

    POST /api/policies/compile   { "agent_id": "agent_ops_01", "text": "..." }  ->  { policy, warnings, diff, unsupported }
    POST /api/policies/apply     { "agent_id": "agent_ops_01", "policy": {...}, "source_text": "..." }

`compile` only proposes a policy (it never applies anything); `apply` validates it again, versions it and activates it.

## Control plane (admin API)

All routes need `Authorization: Bearer $PURSER_ADMIN_TOKEN` (the admin API is disabled if the token is unset). On Windows use
`curl.exe`, because `curl` in PowerShell is an alias for something else.

| Route | Purpose |
|---|---|
| `GET /api/attempts?agent=&decision=&limit=`, `GET /api/attempts/:id` | The audit trail with rule hits, signals, AI verdict, approval and ledger |
| `GET /api/agents`, `POST /api/agents` | List agents (with freeze reason) / create one (key shown once, default policy applied) |
| `POST /api/agents/:id/freeze`, `/unfreeze`, `POST /api/freeze-all`, `/unfreeze-all` | Kill switch, persisted; a frozen agent is denied at stage 0 |
| `GET /api/approvals?status=pending`, `POST /api/approvals/:id/approve`, `/deny` | Human approval. Approve runs the stored call exactly once |
| `GET /api/policies/:agentId`, `POST /api/policies/compile`, `/apply` | Policy versions and the plain-English compiler |
| `GET /api/stats` | Spend today, blocked count and amount, pending approvals |
| `GET /api/events` | Server-Sent Events: `attempt`, `approval_created`, `approval_resolved`, `agent_status`, `breaker_tripped` (15 s heartbeat; token via header or `?token=`) |
| `POST /api/demo/reset` | Wipe attempts, approvals, ledger and reconciliation, unfreeze everything, restore the seeded policy |

Behaviour worth knowing:

- **Approve is exactly-once.** The `pending -> approved` claim is one atomic update done before anything is executed, so
  concurrent or repeated approvals lose the claim (HTTP 409) and cannot pay twice. The payout also carries an idempotency key
  derived from the attempt id. Approval overrides escalate-level rules only: the hard rules are re-checked at approval time, so
  a human cannot approve past a spending cap that was reached in the meantime.
- **Approvals expire** after `approval_ttl_sec` (a background sweeper marks them; an expired approval cannot be approved).
- **Circuit breaker.** `breaker.max_denies` denies within `breaker.window_sec` freeze the agent and emit `breaker_tripped`; the
  reason and numbers appear under `freeze` in `GET /api/agents`. Kill-switch and human-approval denials do not count.

Try it (server running with `pnpm --filter @purser/server dev`):

    pnpm --filter @purser/server mcp:try -- --escalate-only       # $160 to Acme, escalated, nothing executes
    curl.exe -X POST -H "Authorization: Bearer $env:PURSER_ADMIN_TOKEN" http://127.0.0.1:8799/api/approvals/<approval_id>/approve

## Reconciliation (feature 8)

Purser checks PayPal's view against its own ledger. Findings are stored in `reconciliation`, listed at
`GET /api/reconciliation`, and each non-ok finding is pushed over SSE as `reconciliation_finding`.

| Finding | Meaning |
|---|---|
| `unrecorded_movement` | PayPal shows a payout or refund Purser has no executed record of (a bypass or compromised credential) |
| `amount_mismatch` | PayPal's amount, currency or receiver differs from what Purser approved |
| `duplicate` | PayPal sent the same outcome for one payout under a different event id |
| `payout_denied_or_unclaimed` | A recorded payout was failed, blocked, held, returned, refunded, canceled or left unclaimed |

**Webhook receiver** `POST /webhooks/paypal` verifies the signature with PayPal's `verify-webhook-signature` endpoint using the
exact raw request body and `PAYPAL_WEBHOOK_ID`, before anything else. An invalid signature is a 401; if PayPal's verify endpoint
is unreachable it answers 503 so PayPal retries; without `PAYPAL_WEBHOOK_ID` it refuses everything. Event ids are stored, so
replays are ignored. Handled: `PAYMENT.PAYOUTS-ITEM.{SUCCEEDED,FAILED,BLOCKED,HELD,RETURNED,REFUNDED,UNCLAIMED,CANCELED}`,
`PAYMENT.PAYOUTSBATCH.{PROCESSING,SUCCESS,DENIED}` and `PAYMENT.CAPTURE.{COMPLETED,PENDING,REVERSED,DENIED,DECLINED,REFUNDED}`
(plus `PAYMENT.PAYOUTS-ITEM.DENIED`, which is not in PayPal's current list but appears in older docs). Payouts are matched
through `sender_item_id` (Purser sets it to the attempt id) or the stored batch id.

> **Live signature verification is still pending deployment.** PayPal can only call a public URL, so the signature path is
> covered by tests with a mocked verification endpoint. After deploying, set `PAYPAL_WEBHOOK_ID` and register
> `https://<your-host>/webhooks/paypal` in the PayPal developer dashboard.

**Without a public URL** use the dev-only simulator (not registered when `NODE_ENV=production`; it skips signature checks):

    curl.exe -X POST -H "Authorization: Bearer $env:PURSER_ADMIN_TOKEN" -H "content-type: application/json" `
      --data-binary "@event.json" http://127.0.0.1:8799/api/dev/simulate-webhook

**Manual run** `POST /api/reconciliation/run` (optional `{"since": "<ISO>"}` or `{"lookback_hours": 24}`) looks up the payout batch
for every ledger row and reads recent transactions from Transaction Search. Sandbox search can trail real time by hours, so the
response reports `transaction_search.status` (`ok`, `lagging`, `unavailable`, `skipped`) and a note; a lagging or failing search
never fails the run, and webhooks plus batch lookups still cover the gap.

**Demo** `pnpm --filter @purser/server demo:oob-payout` sends a direct $5 payout to the Northwind vendor through the PayPal adapter,
bypassing Purser, then feeds the matching simulated webhook events to the running server. Reconciliation flags it as
`unrecorded_movement` and the finding appears on the SSE stream.

## Demo agent and attack scenarios (feature 3)

`/agent` holds the demo agent and four scenarios (A poisoned invoice, B structuring, C runaway loop, D happy path). Each scenario
has two ways to run, and both write to the same `attempts` table, so the dashboard cannot tell them apart:

| Mode | What drives the tool calls | Purpose |
|---|---|---|
| `replay` | A scripted sequence of tool calls (no LLM). The AI reviewer answers from cached verdicts. | The guaranteed demo path: same decisions every run. |
| `live` | A real agent: an OpenAI-style tool-calling loop on the same LLM client as the reviewer (`LLM_*` in `.env`, Groq by default), connected to `/mcp` with `AGENT_API_KEY`. Capped at 8 model turns; a 429 waits once. | A bonus. A real model reads the fixtures and decides for itself. |

The live agent's prompt is its mandate (SPEC section 10) plus generic helpful-agent instructions. It never mentions Purser and never
asks for anything improper. Attacks come only from the documents it reads (`agent/fixtures`); the poisoned invoice is an
ordinary-looking invoice with a change-of-payment-details footer and contains nothing addressed to an AI.

    pnpm --filter agent run scenario A --mode replay      # or --mode live
    pnpm --filter agent run all --mode replay
    pnpm --filter agent run warm                          # replay everything once to fill the AI verdict cache (server on AI_MODE=live)
    pnpm demo:verify                                      # offline replay check, green/red summary, non-zero exit on failure

Each scenario resets the demo state first (`POST /api/demo/reset`) so rolling windows never pollute a run, changes the policy only
for its own duration, and restores it afterwards. C leaves the agent frozen on purpose (the circuit breaker's result); the next
reset or the operator unfreezes it. The server must be running (`pnpm dev`).

**Real sandbox money moves** in D ($120 to Acme), B (the first two $90 payouts to Northwind) and C (a $10 sandbox capture and three
$1 refunds). A moves nothing: its payout goes to a look-alike address that is never a real account, and is held for approval.
Note that a demo reset clears the ledger, so a later reconciliation run can report earlier demo payouts as unrecorded.

**Scenario C uses a real capture.** A real sandbox capture normally needs a buyer to approve the order in a browser. Instead, setup
creates the order through the Orders API with PayPal's published sandbox test card, which completes in one call with no redirect, and
returns a real capture id. That setup call plays the customer; it is not an agent action and does not go through Purser. The
refunds themselves go through Purser to PayPal's `create_refund`. The AI reviewer is shown PayPal ids as `<paypal-id>`, so a fresh
capture on every run still hits the cached verdict.

**`pnpm demo:verify`** starts its own server with `AI_MODE=cached_only` and an LLM URL that goes nowhere, so a real model call is
impossible, then runs all four scenarios in replay and asserts: D allowed and in the ledger; A escalated with `lookalike_payee`,
an AI rationale, and then denied by a human through the API with no money moved; B ends in a deny by structuring or the daily cap;
C ends in a velocity deny with the agent frozen by the circuit breaker; every AI verdict came from the cache; the seeded policy was
restored. It needs cached verdicts (run `warm` once) and the PayPal sandbox for the payouts. Stop the dev server first: both use
the same database. Set `DEMO_VERIFY_PORT` if 8811 is taken.

**Attack Lab API.** `POST /api/demo/run/:scenario` with `{"mode":"replay"|"live","reset":true}` starts a scenario as a background job
(202, one at a time) and streams progress as `scenario_log` events on `/api/events`; `GET /api/demo/status` shows the current and last run.
For a guaranteed offline demo start the server with `AI_MODE=cached_only`.

## Dashboard (web)

A soft light dashboard (tokens in `web/src/theme/tokens.css`): Live decisions grid with a row-click explanation drawer, Approvals, Attack Lab, Policies (plain-English compiler with a proposal/diff/warnings preview, apply, version history, raw JSON), Reconciliation (findings grid, Run now with the transaction-search status, live SSE highlights), the kill switch with its red frozen banner, a compact Agents bar and a "how this works" modal.

```bash
pnpm --filter @purser/web dev      # http://127.0.0.1:5173, proxies /api to the backend port from .env
pnpm --filter @purser/web build    # then `pnpm --filter @purser/server start` serves web/dist at /
pnpm --filter @purser/web verify:ui  # Part A walkthrough against the running backend (moves $120 + $160 of sandbox money)
pnpm --filter @purser/web verify:ui:b # Policies + Reconciliation (one $5 out-of-band payout; SKIP_OOB=1 skips it)
```

Sign in with `PURSER_ADMIN_TOKEN` from `.env` (kept in sessionStorage only). `verify:ui` moves real sandbox money (scenario D pays $120, the approved escalation pays $160) and denies the look-alike payout.

### Restyling the dashboard

Every colour, font, radius, shadow and motion timing lives in `web/src/theme/tokens.css`. The AG Grid theme reads the same CSS variables, so editing that one file restyles the whole UI. Lime is reserved for active, selected and hover states; allow / escalate / deny colours are used only for decisions.
