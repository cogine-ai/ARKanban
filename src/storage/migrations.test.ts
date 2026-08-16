import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "./repository.js";
import { applyMigrations, MIGRATIONS, readSchemaVersion, TARGET_SCHEMA_VERSION } from "./migrations.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-migrations-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Recreates the pre-framework layout: baseline DDL, meta rows, no schema_version. */
function legacyDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  MIGRATIONS[0]!.up(db);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('epoch', 'legacy-epoch')").run();
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('revision', '7')").run();
  db.exec(`
    INSERT INTO activities (
      id, source_key, kind, origin, catalog, agent_id, title, state, outcome, phase,
      attention, stage, freshness, updated_at, last_observed_at, evidence_json, fingerprint
    ) VALUES ('a-1', 'task:1', 'task', 'online', 'operational', 'builder', 'Legacy task',
      'active', 'none', 'none', 'none', 'in_flight', 'live', 1000, 1000, '[]', 'fp')
  `);
  db.close();
}

describe("schema migrations", () => {
  it("brings a fresh database straight to the target version", () => {
    const databasePath = path.join(workspace(), "fresh.sqlite");
    const db = new DatabaseSync(databasePath);
    cleanups.push(() => db.close());

    const result = applyMigrations(db, databasePath);

    expect(result.from).toBe(0);
    expect(result.to).toBe(TARGET_SCHEMA_VERSION);
    expect(result.backupPath).toBeUndefined();
    expect(readSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);
  });

  it("replays the idempotent baseline over a pre-framework database without touching existing rows", () => {
    const databasePath = path.join(workspace(), "legacy.sqlite");
    legacyDatabase(databasePath);

    const db = new DatabaseSync(databasePath);
    cleanups.push(() => db.close());
    expect(readSchemaVersion(db)).toBe(0);

    const result = applyMigrations(db, databasePath);

    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.name));
    const survivor = db.prepare("SELECT title, session_ref FROM activities WHERE id = 'a-1'").get() as {
      title: string;
      session_ref: unknown;
    };
    expect(survivor.title).toBe("Legacy task");
    expect(survivor.session_ref).toBeNull();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()).toMatchObject({ value: "7" });
  });

  it("writes a 0600 backup before upgrading a database that already holds data", () => {
    const databasePath = path.join(workspace(), "legacy.sqlite");
    legacyDatabase(databasePath);
    const db = new DatabaseSync(databasePath);
    cleanups.push(() => db.close());

    const result = applyMigrations(db, databasePath);

    expect(result.backupPath).toBe(`${databasePath}.pre-v${TARGET_SCHEMA_VERSION}.bak`);
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
  });

  it("is a no-op on the second run", () => {
    const databasePath = path.join(workspace(), "repeat.sqlite");
    const first = new CollectorRepository(databasePath);
    first.close();

    const db = new DatabaseSync(databasePath);
    cleanups.push(() => db.close());
    const result = applyMigrations(db, databasePath);

    expect(result.applied).toEqual([]);
    expect(result.from).toBe(TARGET_SCHEMA_VERSION);
  });

  it("rolls back and fails closed when a migration throws", () => {
    const databasePath = path.join(workspace(), "broken.sqlite");
    const db = new DatabaseSync(databasePath);
    cleanups.push(() => db.close());
    db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY)");

    // The version-2 migration creates `agents`, so the pre-existing table collides.
    expect(() => applyMigrations(db, databasePath)).toThrow();
    expect(readSchemaVersion(db)).toBe(0);
    const sessions = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get();
    expect(sessions).toBeUndefined();
  });
});
