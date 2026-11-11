# Purser

Spending firewall for AI agents on PayPal. Agents get a PayPal account; Purser holds the purse strings.

> Work in progress for the PayPal AI Hackathon. See [SPEC.md](SPEC.md).

## Quick start (Windows, macOS, Linux)

    pnpm install
    copy .env.example .env      # then fill in values (never commit .env)
    pnpm dev                    # server on :8799, web on :5173
    pnpm test
    pnpm typecheck

Sandbox only. No live PayPal credentials.

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

A dark "mission control" UI: Live decisions grid with a row-click explanation drawer, Approvals, Attack Lab, the kill switch with its red frozen banner, an Agents panel and a "how this works" modal. The Policies and Reconciliation pages are marked "coming next".

```bash
pnpm --filter @purser/web dev      # http://127.0.0.1:5173, proxies /api to the backend port from .env
pnpm --filter @purser/web build    # then `pnpm --filter @purser/server start` serves web/dist at /
pnpm --filter @purser/web verify:ui  # drives Edge against the running backend and writes docs/screens/*.png
```

Sign in with `PURSER_ADMIN_TOKEN` from `.env` (kept in sessionStorage only). `verify:ui` moves real sandbox money (scenario D pays $120, the approved escalation pays $160) and denies the look-alike payout.

### Restyling the dashboard

Every colour, font, radius, shadow and motion timing lives in `web/src/theme/tokens.css`. The AG Grid theme reads the same CSS variables, so editing that one file restyles the whole UI. Lime is reserved for active, selected and hover states; allow / escalate / deny colours are used only for decisions.
