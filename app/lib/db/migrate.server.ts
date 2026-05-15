import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../../load-context";
import journalRaw from "../../../drizzle/meta/_journal.json";
import { MIGRATIONS } from "./migrations";

// Tiny Drizzle-compatible migration runner. Walks the journal in idx
// order, applies any SQL whose tag is not yet recorded in
// migrations_applied. Idempotent: safe to call from a request loader
// or a one-off route. The journal acts as the source of truth for
// migration order — Drizzle silently skips files not registered there
// (caused F-124/F-126 P0s in AppApprove core).
//
// Migration SQL is inlined in `./migrations.ts` rather than imported
// from drizzle/*.sql via `?raw` — the wrangler/esbuild bundler that
// builds the deployed Worker has no .sql loader, so `?raw` works in
// Vite-dev only and breaks the deploy. The on-disk .sql files exist
// so wrangler-d1-migrations + the Drizzle CLI see them; the Worker
// reads from the TS const.

interface JournalEntry {
  idx: number;
  tag: string;
  version?: string;
  when?: number;
}

interface Journal {
  entries: JournalEntry[];
}

const SQL_BY_TAG: Record<string, string> = Object.fromEntries(
  MIGRATIONS.map((m) => [m.tag, m.sql]),
);

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

export async function runMigrations(context: AppLoadContext): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const db = env.D1;
  if (!db) {
    return { applied: [], skipped: [] };
  }
  // Bootstrap the ledger before reading from it.
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS migrations_applied (hash TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )
    .run();
  const journal = journalRaw as unknown as Journal;
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const sql = SQL_BY_TAG[entry.tag];
    if (!sql) {
      skipped.push(entry.tag);
      continue;
    }
    const seen = await db
      .prepare("SELECT hash FROM migrations_applied WHERE hash = ?")
      .bind(entry.tag)
      .first<{ hash: string }>();
    if (seen) {
      skipped.push(entry.tag);
      continue;
    }
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await db.prepare(stmt).run();
    }
    await db
      .prepare(
        "INSERT INTO migrations_applied (hash, applied_at) VALUES (?, ?)",
      )
      .bind(entry.tag, Date.now())
      .run();
    applied.push(entry.tag);
  }
  return { applied, skipped };
}
