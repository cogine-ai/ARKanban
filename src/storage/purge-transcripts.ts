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
};

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
  try {
    messagesRemoved = repository.transcripts.purgeAll();
    // VACUUM rewrites the file, which is what actually retires the free pages
    // still holding the deleted text. It cannot run inside a transaction.
    repository.vacuum();
  } finally {
    repository.close();
  }

  const backupsRemoved: string[] = [];
  for (const backup of findMigrationBackups(databasePath)) {
    rmSync(backup, { force: true });
    backupsRemoved.push(backup);
  }

  return { messagesRemoved, backupsRemoved, vacuumed: true };
}
