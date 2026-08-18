import { chmodSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

export type MigrationResult = {
  from: number;
  to: number;
  applied: string[];
  backupPath?: string;
};

/**
 * Version 1 is the v1 blueprint baseline. Every statement is idempotent, so a
 * database created before the migration framework existed can simply replay it
 * as a no-op instead of needing to be detected as a special case.
 */
const baseline: Migration = {
  version: 1,
  name: "baseline-activities",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        catalog TEXT NOT NULL,
        task_id TEXT,
        run_ref TEXT,
        session_key TEXT,
        parent_task_id TEXT,
        flow_id TEXT,
        agent_id TEXT NOT NULL,
        runtime TEXT,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT NOT NULL,
        phase TEXT NOT NULL,
        attention TEXT NOT NULL,
        stage TEXT NOT NULL,
        freshness TEXT NOT NULL,
        progress_summary TEXT,
        last_tool_name TEXT,
        created_at INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_run_ref ON activities(run_ref);
      CREATE INDEX IF NOT EXISTS idx_activities_session_key ON activities(session_key);
      CREATE INDEX IF NOT EXISTS idx_activities_updated_at ON activities(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activities_terminal_at
        ON activities(catalog, COALESCE(ended_at, updated_at) DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        phase TEXT,
        status TEXT,
        tool_name TEXT,
        occurred_at INTEGER NOT NULL,
        FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_activity ON observations(activity_id, occurred_at DESC);
    `);
  },
};

/**
 * Version 2 introduces the Agents session surface described in the v1.1
 * amendment: Agent and Session become first-class entities, and Activity gains
 * a confirmed foreign key to Session.
 *
 * `activities.session_ref` is deliberately a new column rather than a reuse of
 * `session_key`. `session_key` is what an event claimed; `session_ref` is a key
 * confirmed to exist in `sessions`. "Claimed but not yet observed in
 * sessions.list" is a legitimate intermediate state that would be erased by
 * collapsing the two.
 */
/**
 * The transcript archive is unusable without FTS5, and `node:sqlite` cannot load
 * extensions, so a build without it cannot be worked around at runtime. Fail with
 * an actionable message rather than letting CREATE VIRTUAL TABLE raise
 * "no such module: fts5" from inside a migration.
 */
export function assertFts5Available(db: DatabaseSync): void {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(probe)");
    db.exec("DROP TABLE temp.fts5_probe");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This build of node:sqlite lacks FTS5, which the transcript archive requires (${detail}). ` +
        "Run Collector on a Node.js build compiled with SQLITE_ENABLE_FTS5.",
    );
  }
}

const agentsSessionSurface: Migration = {
  version: 2,
  name: "agents-session-surface",
  up(db) {
    assertFts5Available(db);
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        runtime TEXT,
        model TEXT,
        origin TEXT NOT NULL,
        first_observed_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        fingerprint TEXT NOT NULL
      );

      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT,
        agent_id TEXT NOT NULL,
        label TEXT NOT NULL,
        runtime TEXT,
        model TEXT,
        category TEXT,
        kind_hint TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        has_active_run INTEGER NOT NULL DEFAULT 0,
        placement TEXT,
        parent_session_key TEXT,
        previous_session_id TEXT,
        fork_source_key TEXT,
        spawned_by TEXT,
        spawn_depth INTEGER,
        subagent_role TEXT,
        worktree_branch TEXT,
        created_at INTEGER,
        last_activity_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        coverage_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );

      CREATE INDEX idx_sessions_agent_activity ON sessions(agent_id, last_activity_at DESC);
      CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
      CREATE INDEX idx_sessions_archived ON sessions(archived, last_activity_at DESC);

      CREATE TABLE session_usage_snapshots (
        session_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        peak_context_tokens INTEGER,
        cost_micro_usd INTEGER,
        has_cost INTEGER NOT NULL,
        models_json TEXT NOT NULL,
        PRIMARY KEY (session_key, observed_at),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE TABLE usage_daily_rollup (
        day INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_micro_usd INTEGER,
        session_count INTEGER NOT NULL,
        PRIMARY KEY (day, agent_id, model)
      );

      CREATE TABLE session_signals (
        session_key TEXT PRIMARY KEY,
        algorithm_version INTEGER NOT NULL,
        computed_at INTEGER NOT NULL,
        grade TEXT NOT NULL,
        score INTEGER,
        outcome TEXT NOT NULL,
        confidence TEXT NOT NULL,
        tool_failures INTEGER NOT NULL,
        tool_retries INTEGER NOT NULL,
        consecutive_failure_max INTEGER NOT NULL,
        penalties_json TEXT NOT NULL,
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      -- Created here and dropped again by v4. Left in place because a shipped
      -- migration describes what a database at that version actually contains,
      -- and rewriting it would make v2 a lie about every database that ran it.
      CREATE TABLE session_message_stats (
        session_key TEXT NOT NULL,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        outcome TEXT NOT NULL,
        count INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, direction, channel, outcome)
      );

      ALTER TABLE activities ADD COLUMN session_ref TEXT;
      CREATE INDEX idx_activities_session_ref ON activities(session_ref);
    `);

    // Transcript archive. The tables are created here even though the sync loop
    // lands in a later slice: they change the size and the security class of the
    // whole database, so deferring them would mean a second migration plus a
    // full-database backfill.
    db.exec(`
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        -- Empty string, not NULL, marks an unknown generation: SQLite treats NULLs
        -- as distinct in UNIQUE constraints, which would defeat the idempotency key.
        session_id TEXT NOT NULL DEFAULT '',
        message_id TEXT,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        channel TEXT,
        tool_name TEXT,
        content TEXT NOT NULL,
        content_bytes INTEGER NOT NULL,
        superseded_by_session_id TEXT,
        divergent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        UNIQUE (session_key, seq, session_id)
      );

      CREATE INDEX idx_session_messages_session ON session_messages(session_key, seq);
      CREATE INDEX idx_session_messages_created ON session_messages(created_at DESC);
      CREATE INDEX idx_session_messages_message_id ON session_messages(message_id);

      CREATE TABLE session_transcript_sync (
        session_key TEXT PRIMARY KEY,
        cursor TEXT,
        last_seq INTEGER,
        last_message_id TEXT,
        synced_count INTEGER NOT NULL DEFAULT 0,
        synced_bytes INTEGER NOT NULL DEFAULT 0,
        complete INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER,
        error_code TEXT,
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );
    `);

    // The default unicode61 tokenizer treats a run of CJK as a single token and
    // cannot match Chinese substrings at all. trigram can, at the cost of a hard
    // three-character minimum on queries — shorter terms fall back to LIKE.
    db.exec(`
      CREATE VIRTUAL TABLE session_messages_fts USING fts5(
        content,
        content='session_messages',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER session_messages_au AFTER UPDATE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  },
};

/**
 * The daily rollup was storing each day's cumulative reading, so summing the days
 * counted a session once per day it stayed alive. It now stores per-day
 * increments, differenced against how much of a session has already been folded.
 *
 * Existing rollup rows are inflated by that bug and the snapshots they came from
 * are gone, so there is nothing to recompute them from: they are dropped rather
 * than kept as a wrong number in a view about money. Watermarks start empty, so
 * the next fold contributes each live session's full total to date.
 */
const usageRollupIncrements: Migration = {
  version: 3,
  name: "usage-rollup-increments",
  up(db) {
    db.exec(`
      CREATE TABLE usage_rollup_watermark (
        session_key TEXT PRIMARY KEY,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_micro_usd INTEGER,
        -- The day bucket that counted this session, null if no folded day ever
        -- did. A session is counted once, on the first day it is folded, so
        -- summing days does not count it again; the day is kept so a range
        -- summary can tell whether that one count falls inside it.
        first_day INTEGER,
        -- Once the session is gone its readings cascade away too, and a fold
        -- record for a session that no longer exists is only future growth.
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      DELETE FROM usage_daily_rollup;
    `);
  },
};

/**
 * Version 4 drops a table nothing ever wrote to.
 *
 * `session_message_stats` was created with the rest of the session surface for a
 * per-channel message breakdown that has not been built: no code writes it and no
 * code reads it. An empty table is not neutral — it reads as a breakdown that
 * exists and happens to be empty, which is a different claim from "never
 * collected", and the same conflation this project refuses everywhere else. It
 * comes back with the collection path that fills it.
 */
const dropUnusedMessageStats: Migration = {
  version: 4,
  name: "drop-unused-message-stats",
  up(db) {
    db.exec("DROP TABLE IF EXISTS session_message_stats");
  },
};

export const MIGRATIONS: readonly Migration[] = [
  baseline,
  agentsSessionSurface,
  usageRollupIncrements,
  dropUnusedMessageStats,
];

export const TARGET_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

export function readSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "meta")) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value?: unknown }
    | undefined;
  const stored = typeof row?.value === "string" ? Number.parseInt(row.value, 10) : Number.NaN;
  return Number.isInteger(stored) && stored > 0 ? stored : 0;
}

/**
 * Opening a `DatabaseSync` creates the file, so an existing path proves nothing.
 * Only a database that already holds tables is worth backing up.
 */
function hasContent(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  return row !== undefined;
}

function backupBeforeMigration(db: DatabaseSync, databasePath: string, target: number): string | undefined {
  if (!existsSync(databasePath)) return undefined;
  const backupPath = `${databasePath}.pre-v${target}.bak`;
  // The copy cannot be taken under the write lock — folding the WAL into the main
  // file is not permitted inside a transaction — so two processes starting at the
  // same moment can both reach this point, and the second may arrive after the
  // first has already migrated. Overwriting then replaced the pre-migration copy
  // with a post-migration one under a name that says otherwise, which is the one
  // way this file can fail the only job it has. Whatever is already here was
  // copied before this target's migration by definition, so it is kept.
  if (existsSync(backupPath)) return backupPath;
  // WAL content must be folded into the main file before it can be copied.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(databasePath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function pendingFrom(version: number): Migration[] {
  return MIGRATIONS.filter((migration) => migration.version > version).sort(
    (left, right) => left.version - right.version,
  );
}

/**
 * Refuses a database written by a newer build.
 *
 * Silently accepting one means running the current code against a schema it has
 * never seen: columns it does not know about, and constraints it will violate.
 * Downgrades are not supported, and saying so is the only safe answer.
 */
function assertNotNewer(version: number): void {
  if (version > TARGET_SCHEMA_VERSION) {
    throw new Error(
      `Database schema is v${version} but this build understands v${TARGET_SCHEMA_VERSION}. ` +
        "It was written by a newer Collector; downgrading is not supported. Run the newer build, " +
        "or move this database aside to start a fresh one.",
    );
  }
}

/**
 * Removes migration backups other than the one just taken.
 *
 * A backup is a whole copy of the database, transcript text included. Kept
 * forever, they outlive the retention window they were copied from: text that
 * `transcriptRetentionDays` promised to delete stays readable in a file beside
 * the database, and only `purge-transcripts` ever removed it. One generation back
 * is the trade — enough to recover from an upgrade that went wrong, without
 * accumulating conversations nobody can see or search.
 */
function pruneOldBackups(databasePath: string, keep: string | undefined): void {
  const directory = path.dirname(databasePath);
  const prefix = `${path.basename(databasePath)}.pre-v`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".bak")) continue;
    const full = path.join(directory, entry);
    if (full === keep) continue;
    // A backup that cannot be removed is not a reason to refuse to start; the
    // next pass will try again.
    try {
      rmSync(full, { force: true });
    } catch {
      continue;
    }
  }
}

/**
 * Brings the database up to `TARGET_SCHEMA_VERSION`.
 *
 * Every pending migration runs inside one transaction. A failure rolls the whole
 * upgrade back and rethrows so the process fails closed rather than starting on
 * a half-migrated database. An existing database is copied to
 * `<path>.pre-v<target>.bak` (mode 0600) before the first statement runs, and
 * earlier backups are removed once the upgrade succeeds.
 */
export function applyMigrations(db: DatabaseSync, databasePath: string): MigrationResult {
  const observed = readSchemaVersion(db);
  assertNotNewer(observed);
  if (pendingFrom(observed).length === 0) {
    return { from: observed, to: observed, applied: [] };
  }

  // Taken before the write lock: folding the WAL into the main file is not
  // permitted inside a transaction, and copying without it would back up a
  // database missing its most recent writes.
  const backupPath = hasContent(db) ? backupBeforeMigration(db, databasePath, TARGET_SCHEMA_VERSION) : undefined;

  db.exec("BEGIN IMMEDIATE");
  let from: number;
  let pending: Migration[];
  try {
    // Re-read under the write lock. Two processes starting together both saw the
    // old version a moment ago, and the one that arrives second used to try
    // creating tables that now exist and fail on a database that is in fact
    // perfectly migrated.
    from = readSchemaVersion(db);
    assertNotNewer(from);
    pending = pendingFrom(from);
    for (const migration of pending) migration.up(db);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
      String(TARGET_SCHEMA_VERSION),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  pruneOldBackups(databasePath, backupPath);

  return {
    from,
    to: TARGET_SCHEMA_VERSION,
    applied: pending.map((migration) => migration.name),
    ...(backupPath ? { backupPath } : {}),
  };
}
