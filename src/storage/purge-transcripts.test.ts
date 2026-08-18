import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorRepository } from "./repository.js";
import { ArchiveBusyError, findMigrationBackups, purgeTranscripts } from "./purge-transcripts.js";

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

  /**
   * The vacuum is the last step and the one most likely to fail — a busy database
   * or a full disk. It used to take the backup deletion down with it, leaving whole
   * pre-upgrade copies of the archive on disk while the command reported success.
   */
  it("deletes the backups even when the free pages cannot be rewritten", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);
    const backup = `${databasePath}.pre-v2.bak`;
    copyFileSync(databasePath, backup);
    const vacuum = vi
      .spyOn(CollectorRepository.prototype, "vacuum")
      .mockImplementation(() => {
        throw new Error("database or disk is full");
      });
    cleanups.push(() => vacuum.mockRestore());

    const result = purgeTranscripts(databasePath);

    expect(result.messagesRemoved).toBe(200);
    expect(result.backupsRemoved).toEqual([backup]);
    expect(existsSync(backup)).toBe(false);
    // And it says so, rather than reporting an erasure it did not complete.
    expect(result).toMatchObject({ vacuumed: false, vacuumError: "database or disk is full" });
  });

  /**
   * Purging clears the sync watermarks, so a collector still running would treat
   * every session as uncollected and pull the whole archive back from the Gateway
   * within a round.
   */
  it("refuses to start while another process holds the database", () => {
    const directory = workspace();
    const databasePath = path.join(directory, "collector.sqlite");
    seed(databasePath);
    const probe = vi.spyOn(CollectorRepository.prototype, "probeExclusive").mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    cleanups.push(() => probe.mockRestore());

    expect(() => purgeTranscripts(databasePath)).toThrow(ArchiveBusyError);

    // Nothing was deleted, so the operator can stop the collector and retry.
    const repository = new CollectorRepository(databasePath);
    cleanups.push(() => repository.close());
    expect(repository.transcripts.listMessages("agent:builder:1")).toHaveLength(200);
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
