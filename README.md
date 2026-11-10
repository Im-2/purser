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
