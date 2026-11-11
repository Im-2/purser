import { readFileSync } from "node:fs";
import path from "node:path";
import { fixturesDir } from "./env.js";

/** Load a fixture document and fill {{PLACEHOLDERS}}. An unknown placeholder is an error, never silently left in. */
export function loadFixture(name: string, vars: Record<string, string>): string {
  const text = readFileSync(path.join(fixturesDir, name), "utf8");
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`fixture ${name} needs ${key}`);
    return v;
  });
}
