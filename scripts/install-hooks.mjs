#!/usr/bin/env node
// Installs the git pre-push hook (works on Windows: Git for Windows runs hooks with its bundled sh).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const gitDir = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).stdout.trim();
if (!gitDir) {
  // a build environment without .git (a tarball, some CI): nothing to install, and that is fine
  console.log("install-hooks: not a git repository, skipping");
  process.exit(0);
}
mkdirSync(gitDir, { recursive: true });
const hook = path.join(gitDir, "pre-push");
const body = `#!/bin/sh
# Installed by scripts/install-hooks.mjs. Blocks the push if secrets could leak.
root="$(git rev-parse --show-toplevel)"
node "$root/scripts/check-secrets.mjs" --history || { echo "pre-push: secret check failed, push blocked" >&2; exit 1; }
`;
writeFileSync(hook, body, { mode: 0o755 });
try { chmodSync(hook, 0o755); } catch { /* no-op on Windows */ }
console.log(`install-hooks: wrote ${hook}`);
