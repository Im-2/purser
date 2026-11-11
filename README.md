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
