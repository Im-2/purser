import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrations.js";

export type Db = Database.Database;

/** Open (and migrate) a SQLite database. Use ":memory:" for tests. */
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export { migrate } from "./migrations.js";
export { createRepos, hashApiKey, type Repos } from "./repos.js";
