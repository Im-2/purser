# CLAUDE.md

- Read SPEC.md first. It is the source of truth.
- Never commit secrets. `.env` and `.sandbox/` are git-ignored; never print `.env`.
- Sandbox only (`PAYPAL_ENV=sandbox`). No live credentials anywhere.
- Fail closed: unknown tool, unknown amount, reviewer error, upstream error before execution.
- AI can only tighten decisions, never loosen them.
- Run `pnpm test` and `pnpm typecheck` before saying a task is done.
- Windows-friendly: no bash-only scripts or syntax in package.json scripts; use `path.join`; spawn `npx` as `npx.cmd` when `process.platform === "win32"`.
- Layout: /server (gateway), /web (dashboard), /agent (demo agent), /shared (zod schemas), /docs.
