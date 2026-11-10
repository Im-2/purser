import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (server/src -> repo). pnpm --filter runs with cwd=server, so never rely on cwd. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Load <repo>/.env into process.env if present. Real environment variables win. Never prints values. */
export function loadDotEnv(): void {
  const file = path.join(repoRoot, ".env");
  if (!existsSync(file)) return;
  process.loadEnvFile(file); // does not override existing vars
}

/** Resolve DATABASE_PATH against the repo root (":memory:" passes through). */
export function resolveDbPath(p: string): string {
  return p === ":memory:" || path.isAbsolute(p) ? p : path.join(repoRoot, p);
}
