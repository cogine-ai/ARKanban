import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { CollectorRepository } from "./repository.js";

/**
 * Erases every archived transcript.
 *
 * Deleting the rows is not enough on its own. SQLite leaves the old pages on
 * the free list where the text is still recoverable, and each migration backup
 * is a full copy of the database from before the upgrade — transcripts
 * included. Invariant 9 requires all three to go together, so this is one
 * operation rather than a delete the operator is trusted to follow up on.
 */

export type PurgeResult = {
  messagesRemoved: number;
  backupsRemoved: string[];
  vacuumed: boolean;
  /**
   * Why the free pages could not be rewritten, when that is the only step that
   * failed. The rows and the backups are already gone; what remains is text in
   * pages SQLite has released but not overwritten.
   */
  vacuumError?: string;
};

/** Raised before anything is deleted, so the operator can stop the collector. */
export class ArchiveBusyError extends Error {
  constructor() {
    super(
      "another process is using the database — stop the collector before purging, " +
        "or it will re-download the transcripts within a minute",
    );
    this.name = "ArchiveBusyError";
  }
}

/** Backups are written as `<database>.pre-v<target>.bak` beside the database. */
export function findMigrationBackups(databasePath: string): string[] {
  const directory = path.dirname(path.resolve(databasePath));
  const prefix = `${path.basename(databasePath)}.pre-v`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".bak"))
    .map((entry) => path.join(directory, entry))
    .sort();
}

export function purgeTranscripts(databasePath: string): PurgeResult {
  const repository = new CollectorRepository(databasePath);
  let messagesRemoved = 0;
  const backupsRemoved: string[] = [];
  let vacuumError: string | undefined;
  try {
    // A running collector would win nothing here and cost a great deal: purging
    // clears the sync watermarks, so within a round it would pull every
    // transcript back down from the Gateway. Refusing up front leaves the archive
    // exactly as it was.
    requireExclusiveAccess(repository);

    messagesRemoved = repository.transcripts.purgeAll();

    // Before the vacuum, not after. Each backup is a whole database from before
    // an upgrade, transcripts included, and a vacuum that throws — a busy
    // database, a full disk — used to skip this loop entirely and leave every
    // one of them on disk while reporting the purge as done.
    for (const backup of findMigrationBackups(databasePath)) {
      rmSync(backup, { force: true });
      backupsRemoved.push(backup);
    }

    // VACUUM rewrites the file, which is what actually retires the free pages
    // still holding the deleted text. It cannot run inside a transaction.
    try {
      repository.vacuum();
    } catch (error) {
      vacuumError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    repository.close();
  }

  return {
    messagesRemoved,
    backupsRemoved,
    vacuumed: vacuumError === undefined,
    ...(vacuumError !== undefined ? { vacuumError } : {}),
  };
}

/**
 * Fails unless this process is the only one holding the database.
 *
 * An exclusive transaction is the cheapest probe available: SQLite refuses it
 * while another connection holds a lock. It is not proof of solitude — a
 * collector idling between rounds holds nothing — so the CLI also says to stop
 * the collector first.
 */
function requireExclusiveAccess(repository: CollectorRepository): void {
  try {
    repository.probeExclusive();
  } catch {
    throw new ArchiveBusyError();
  }
}
