import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "./repository.js";
import { findMigrationBackups, purgeTranscripts } from "./purge-transcripts.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const SECRET = "the passphrase is hunter2 and it must not survive a purge";

function workspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-purge-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Seeds a database holding one transcript plus the session metadata around it. */
function seed(databasePath: string): void {
  const repository = new CollectorRepository(databasePath);
  repository.upsertSessions([
    {
      sessionKey: "agent:builder:1",
      agentId: "builder",
      label: "Credentials review",
      kindHint: "main",
      archived: false,
      hasActiveRun: false,
      lineage: {},
      lastActivityAt: 5_000,
      observedAt: 5_000,
      coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "live" },
    },
  ]);
  repository.transcripts.append(
    // Enough copies that the text lands on pages VACUUM has to reclaim rather
    // than living entirely inside a single partially-used page.
    Array.from({ length: 200 }, (_, index) => ({
      sessionKey: "agent:builder:1",
      seq: index,
      role: "user" as const,
      content: `${SECRET} #${index}`,
      createdAt: 1_000 + index,
      observedAt: 1_000 + index,
    })),
  );
  repository.transcripts.recordSync({ sessionKey: "agent:builder:1", complete: true, syncedAt: 9_000 });
  repository.close();
}

describe("purge-transcripts", () => {
  it("removes every message while leaving session metadata in place", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);

    const result = purgeTranscripts(databasePath);
    expect(result.messagesRemoved).toBe(200);

    const repository = new CollectorRepository(databasePath);
    cleanups.push(() => repository.close());
    expect(repository.transcripts.listMessages("agent:builder:1")).toEqual([]);
    expect(repository.getSession("agent:builder:1")).toMatchObject({ label: "Credentials review" });
  });

  it("leaves no trace of the text in the database file", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);

    // Confirms the check is meaningful: the text really is in the file first.
    expect(readFileSync(databasePath, "latin1")).toContain(SECRET);

    purgeTranscripts(databasePath);

    // A plain DELETE would leave this readable on the free list.
    expect(readFileSync(databasePath, "latin1")).not.toContain(SECRET);
  });

  it("deletes migration backups, which hold the same text", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);
    const backup = `${databasePath}.pre-v2.bak`;
    copyFileSync(databasePath, backup);

    const result = purgeTranscripts(databasePath);

    expect(result.backupsRemoved).toEqual([backup]);
    expect(existsSync(backup)).toBe(false);
  });

  it("resets the sync watermark so the archive does not look already collected", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);

    purgeTranscripts(databasePath);

    const repository = new CollectorRepository(databasePath);
    cleanups.push(() => repository.close());
    expect(repository.transcripts.syncState("agent:builder:1")).toMatchObject({ syncedCount: 0, complete: false });
  });

  it("only claims the backups that belong to this database", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);
    writeFileSync(`${databasePath}.pre-v2.bak`, "mine");
    writeFileSync(path.join(directory, "other.sqlite.pre-v2.bak"), "someone else's");
    writeFileSync(path.join(directory, "collector.sqlite.notes"), "not a backup");

    expect(findMigrationBackups(databasePath)).toEqual([`${databasePath}.pre-v2.bak`]);
  });
});
