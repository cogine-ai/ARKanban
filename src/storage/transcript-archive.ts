import type { DatabaseSync } from "node:sqlite";
import type {
  ArchivedMessage,
  MessageRole,
  MessageSearchHit,
  MessageSearchResult,
  TranscriptSyncState,
} from "../contracts.js";

/**
 * The single write path for session transcripts.
 *
 * The v1.1 amendment permits transcripts as `local_archive`: full text may be
 * persisted and indexed on this machine, but must never reach logs, SSE, the
 * diagnostic bundle, or any network egress. Concentrating every write here is
 * what makes that auditable — no other module may insert into `session_messages`.
 */

/** FTS5 trigram cannot match anything shorter than three characters. */
export const MIN_FTS_QUERY_LENGTH = 3;

export type MessageWrite = {
  sessionKey: string;
  sessionId?: string;
  messageId?: string;
  seq: number;
  role: MessageRole;
  channel?: string;
  toolName?: string;
  content: string;
  createdAt: number;
  observedAt: number;
};

export type MessageSearchQuery = {
  text: string;
  agentId?: string;
  sessionKey?: string;
  from?: number;
  to?: number;
  limit?: number;
};

/** A session the sync loop may pull history for, with its stored watermark. */
export type TranscriptCandidate = {
  sessionKey: string;
  sessionId?: string;
  cursor?: string;
  lastSeq?: number;
  complete: boolean;
};

export type ArchiveUsage = {
  messageCount: number;
  contentBytes: number;
  /** Actual pages held by the archive tables and their FTS index. */
  storedBytes: number;
};

export type EvictionOutcome = {
  sessions: number;
  messages: number;
  /**
   * False when the protected sessions alone still exceed the ceiling.
   *
   * The caller needs this to tell "made room" apart from "there is no more room
   * to make", because the two call for opposite behaviour: carry on archiving, or
   * stop and say so.
   */
  reachedTarget: boolean;
};

type Row = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowToMessage(row: Row): ArchivedMessage {
  return {
    id: Number(row.id),
    sessionKey: String(row.session_key),
    ...(asString(row.session_id) ? { sessionId: asString(row.session_id) } : {}),
    ...(asString(row.message_id) ? { messageId: asString(row.message_id) } : {}),
    seq: Number(row.seq),
    role: row.role as MessageRole,
    ...(asString(row.channel) ? { channel: asString(row.channel) } : {}),
    ...(asString(row.tool_name) ? { toolName: asString(row.tool_name) } : {}),
    content: String(row.content),
    ...(asString(row.superseded_by_session_id)
      ? { supersededBySessionId: asString(row.superseded_by_session_id) }
      : {}),
    divergent: Number(row.divergent) === 1,
    createdAt: Number(row.created_at),
  };
}

function rowToCandidate(row: Row): TranscriptCandidate {
  return {
    sessionKey: String(row.session_key),
    ...(asString(row.session_id) ? { sessionId: asString(row.session_id) } : {}),
    ...(asString(row.cursor) ? { cursor: asString(row.cursor) } : {}),
    ...(asNumber(row.last_seq) !== undefined ? { lastSeq: asNumber(row.last_seq) } : {}),
    complete: Number(row.complete ?? 0) === 1,
  };
}

/**
 * User input is treated as a literal phrase. FTS5 query syntax has operators
 * (`OR`, `NEAR`, `*`, `-`) that would otherwise turn a plain search string into
 * a malformed query or a surprising one.
 */
function toFtsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function toLikePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export class TranscriptArchive {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Idempotent on `(session_key, seq, session_id)`. Re-fetching a range of
   * history is a no-op rather than a source of duplicate rows.
   *
   * When a re-fetch brings back *different* text for a position already stored,
   * the stored version is kept and flagged. Discarding the difference in silence
   * is what the flag exists to prevent: a transcript that reads as a faithful copy
   * while upstream has since said something else in that turn.
   */
  append(writes: MessageWrite[]): { inserted: number; skipped: number; divergent: number } {
    if (writes.length === 0) return { inserted: 0, skipped: 0, divergent: 0 };
    const statement = this.db.prepare(`
      INSERT INTO session_messages (
        session_key, session_id, message_id, seq, role, channel, tool_name,
        content, content_bytes, created_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_key, seq, session_id) DO NOTHING
    `);
    // Only reached when the insert conflicted, and a no-op unless the text
    // actually differs from what is stored.
    const markDivergent = this.db.prepare(`
      UPDATE session_messages SET divergent = 1
      WHERE session_key = ? AND seq = ? AND session_id = ? AND divergent = 0 AND content <> ?
    `);
    let inserted = 0;
    let divergent = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        const result = statement.run(
          write.sessionKey,
          write.sessionId ?? "",
          write.messageId ?? null,
          write.seq,
          write.role,
          write.channel ?? null,
          write.toolName ?? null,
          write.content,
          Buffer.byteLength(write.content, "utf8"),
          write.createdAt,
          write.observedAt,
        );
        if (Number(result.changes) > 0) {
          inserted += 1;
          continue;
        }
        divergent += Number(
          markDivergent.run(write.sessionKey, write.seq, write.sessionId ?? "", write.content).changes,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { inserted, skipped: writes.length - inserted, divergent };
  }

  /**
   * Marks the messages of a previous transcript generation as superseded when the
   * Gateway reports a new `sessionId` for the same key. The old text is kept: the
   * pre-compaction conversation is usually exactly what a review is looking for.
   */
  supersede(sessionKey: string, newSessionId: string): number {
    const result = this.db
      .prepare(`
        UPDATE session_messages
        SET superseded_by_session_id = ?
        WHERE session_key = ?
          AND session_id <> ?
          AND superseded_by_session_id IS NULL
      `)
      .run(newSessionId, sessionKey, newSessionId);
    return Number(result.changes);
  }

  /**
   * Second line of defence for the idempotency key.
   *
   * `(session_key, seq, session_id)` only makes a re-fetch a no-op when the
   * Gateway numbers its messages. When it does not, sequence numbers are
   * synthesised and a repeated page would be handed fresh ones, so the caller
   * filters on message id instead.
   */
  knownMessageIds(sessionKey: string, ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT message_id FROM session_messages WHERE session_key = ? AND message_id IN (${placeholders})`)
      .all(sessionKey, ...ids) as Row[];
    return new Set(rows.map((row) => String(row.message_id)));
  }

  listMessages(sessionKey: string, options: { afterSeq?: number; limit?: number } = {}): ArchivedMessage[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM session_messages
        WHERE session_key = ? AND seq > ?
        ORDER BY seq ASC, id ASC
        LIMIT ?
      `)
      .all(sessionKey, options.afterSeq ?? -1, options.limit ?? 200) as Row[];
    return rows.map(rowToMessage);
  }

  /**
   * Full-text search over the archive. Never contacts the Gateway, so it keeps
   * working while the connection is down.
   *
   * Queries shorter than three characters cannot use the trigram index and fall
   * back to a LIKE scan. That scan is only allowed when another filter has
   * already narrowed the candidate set — an unbounded LIKE over the whole archive
   * is refused rather than served slowly.
   */
  search(query: MessageSearchQuery): MessageSearchResult {
    const text = query.text.trim();
    const limit = query.limit ?? 50;
    const narrowed = query.agentId !== undefined || query.sessionKey !== undefined || query.from !== undefined;
    const useFts = [...text].length >= MIN_FTS_QUERY_LENGTH;
    if (!useFts && !narrowed) {
      return { mode: "fallback", hits: [], truncated: false };
    }

    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (useFts) {
      conditions.push("session_messages_fts MATCH ?");
      parameters.push(toFtsPhrase(text));
    } else {
      conditions.push("m.content LIKE ? ESCAPE '\\'");
      parameters.push(toLikePattern(text));
    }
    if (query.sessionKey !== undefined) {
      conditions.push("m.session_key = ?");
      parameters.push(query.sessionKey);
    }
    if (query.agentId !== undefined) {
      conditions.push("s.agent_id = ?");
      parameters.push(query.agentId);
    }
    if (query.from !== undefined) {
      conditions.push("m.created_at >= ?");
      parameters.push(query.from);
    }
    if (query.to !== undefined) {
      conditions.push("m.created_at <= ?");
      parameters.push(query.to);
    }
    parameters.push(limit + 1);

    const source = useFts
      ? "session_messages_fts JOIN session_messages m ON m.id = session_messages_fts.rowid"
      : "session_messages m";
    const rows = this.db
      .prepare(`
        SELECT m.*, s.agent_id AS agent_id, s.label AS session_label
        FROM ${source}
        LEFT JOIN sessions s ON s.session_key = m.session_key
        WHERE ${conditions.join(" AND ")}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?
      `)
      .all(...parameters) as Row[];

    const truncated = rows.length > limit;
    const hits: MessageSearchHit[] = rows.slice(0, limit).map((row) => ({
      message: rowToMessage(row),
      agentId: asString(row.agent_id) ?? "Unattributed",
      sessionLabel: asString(row.session_label) ?? String(row.session_key),
    }));
    return { mode: useFts ? "fts" : "fallback", hits, truncated };
  }

  /**
   * Sessions worth pulling an increment for: either running now, or touched
   * recently enough that more messages are likely.
   */
  activeCandidates(options: { now: number; withinMs: number; limit: number }): TranscriptCandidate[] {
    const rows = this.db
      .prepare(`
        SELECT s.session_key, s.session_id, t.cursor, t.last_seq, t.complete
        FROM sessions s
        LEFT JOIN session_transcript_sync t ON t.session_key = s.session_key
        WHERE s.has_active_run = 1 OR s.last_activity_at >= ?
        ORDER BY s.last_activity_at DESC, s.session_key ASC
        LIMIT ?
      `)
      .all(options.now - options.withinMs, options.limit) as Row[];
    return rows.map(rowToCandidate);
  }

  /**
   * Sessions whose history has never been walked to the end. Ordered by recency
   * because a conversation from this morning is likelier to be reviewed than one
   * from last quarter.
   */
  backfillCandidates(options: { limit: number }): TranscriptCandidate[] {
    const rows = this.db
      .prepare(`
        SELECT s.session_key, s.session_id, t.cursor, t.last_seq, t.complete
        FROM sessions s
        LEFT JOIN session_transcript_sync t ON t.session_key = s.session_key
        WHERE COALESCE(t.complete, 0) = 0
        ORDER BY s.last_activity_at DESC, s.session_key ASC
        LIMIT ?
      `)
      .all(options.limit) as Row[];
    return rows.map(rowToCandidate);
  }

  syncState(sessionKey: string): TranscriptSyncState | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_transcript_sync WHERE session_key = ?")
      .get(sessionKey) as Row | undefined;
    if (!row) return undefined;
    return {
      sessionKey,
      syncedCount: Number(row.synced_count),
      syncedBytes: Number(row.synced_bytes),
      complete: Number(row.complete) === 1,
      ...(asNumber(row.synced_at) !== undefined ? { syncedAt: asNumber(row.synced_at) } : {}),
      ...(asString(row.error_code) ? { errorCode: asString(row.error_code) } : {}),
    };
  }

  recordSync(state: {
    sessionKey: string;
    /**
     * Absent leaves the stored token alone, which is what a failed round wants:
     * backfill progress survives. `null` clears it, so the next round starts at
     * the newest page again.
     */
    cursor?: string | null;
    lastSeq?: number;
    lastMessageId?: string;
    complete: boolean;
    syncedAt: number;
    errorCode?: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO session_transcript_sync (
          session_key, cursor, last_seq, last_message_id,
          synced_count, synced_bytes, complete, synced_at, error_code
        )
        SELECT ?, ?, ?, ?,
          COALESCE((SELECT COUNT(*) FROM session_messages WHERE session_key = ?), 0),
          COALESCE((SELECT SUM(content_bytes) FROM session_messages WHERE session_key = ?), 0),
          ?, ?, ?
        ON CONFLICT (session_key) DO UPDATE SET
          cursor = CASE WHEN ? = 1 THEN excluded.cursor ELSE session_transcript_sync.cursor END,
          -- Monotonic: synthesised sequence numbers are counted from this value,
          -- so letting an older backfill page lower it would hand already-used
          -- numbers to new messages, which the unique key then rejects.
          last_seq = CASE
            WHEN excluded.last_seq IS NULL THEN session_transcript_sync.last_seq
            WHEN session_transcript_sync.last_seq IS NULL THEN excluded.last_seq
            ELSE MAX(session_transcript_sync.last_seq, excluded.last_seq)
          END,
          last_message_id = COALESCE(excluded.last_message_id, session_transcript_sync.last_message_id),
          synced_count = excluded.synced_count,
          synced_bytes = excluded.synced_bytes,
          complete = excluded.complete,
          synced_at = excluded.synced_at,
          error_code = excluded.error_code
      `)
      .run(
        state.sessionKey,
        state.cursor ?? null,
        state.lastSeq ?? null,
        state.lastMessageId ?? null,
        state.sessionKey,
        state.sessionKey,
        state.complete ? 1 : 0,
        state.syncedAt,
        state.errorCode ?? null,
        state.cursor === undefined ? 0 : 1,
      );
  }

  /**
   * `storedBytes` comes from dbstat, so it reflects the real page cost of the
   * message table, its indexes and the FTS shadow tables rather than an estimate.
   * dbstat walks every page, so this belongs in the periodic prune cycle and not
   * on any write path.
   */
  /** Cheap aggregate, safe to call from a request handler. */
  totals(): { messageCount: number; contentBytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(content_bytes), 0) AS bytes FROM session_messages")
      .get() as Row;
    return { messageCount: Number(row.count), contentBytes: Number(row.bytes) };
  }

  usage(): ArchiveUsage {
    const totals = this.totals();
    const stored = this.db
      .prepare(`
        SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat
        WHERE name LIKE 'session_messages%'
           OR name LIKE 'idx_session_messages%'
           OR name LIKE 'sqlite_autoindex_session_messages%'
      `)
      .get() as Row;
    return { ...totals, storedBytes: Number(stored.bytes) };
  }

  pruneOlderThan(cutoff: number): number {
    const result = this.db.prepare("DELETE FROM session_messages WHERE created_at < ?").run(cutoff);
    const removed = Number(result.changes);
    if (removed > 0) this.compactIndex();
    return removed;
  }

  /**
   * An FTS5 delete only appends a tombstone, so the index keeps its pages until
   * it is merged. Capacity is measured from those pages: without this, deleting
   * transcripts barely moves the number the budget is compared against, and an
   * archive that has been emptied can still read as over budget.
   *
   * Public because a caller that owns the surrounding transaction deletes through
   * `dropSessionsInTransaction` and has to do this part itself, after committing.
   */
  compactIndex(): void {
    this.db.exec("INSERT INTO session_messages_fts(session_messages_fts) VALUES('optimize')");
  }

  /**
   * Capacity eviction drops whole sessions, oldest first. Trimming individual
   * messages would leave half-conversations behind, which are close to worthless
   * for review and actively misleading in search results.
   *
   * `protectSince` shields sessions that are still producing messages, and with
   * them the conversation someone is most likely reading right now. Without it an
   * over-budget archive tore up the newest session, the next sync round pulled it
   * straight back, and the round after that evicted it again — the archive spent
   * its whole request budget shredding and refetching the same transcript. When
   * the protected sessions alone exceed the ceiling, `reachedTarget` is false and
   * nothing further is deleted: the caller is expected to stop archiving and say
   * so, which is the honest end of a full disk.
   */
  evictOldestSessions(targetStoredBytes: number, options: { protectSince?: number } = {}): EvictionOutcome {
    const usage = this.usage();
    if (usage.storedBytes <= targetStoredBytes || usage.contentBytes === 0) {
      return { sessions: 0, messages: 0, reachedTarget: true };
    }
    const protectSince = options.protectSince ?? Number.POSITIVE_INFINITY;
    const candidates = this.db
      .prepare(`
        SELECT m.session_key AS session_key,
               SUM(m.content_bytes) AS bytes,
               COALESCE(s.last_activity_at, MIN(m.created_at)) AS activity,
               COALESCE(s.has_active_run, 0) AS active_run
        FROM session_messages m
        LEFT JOIN sessions s ON s.session_key = m.session_key
        GROUP BY m.session_key
        HAVING active_run = 0 AND activity < ?
        ORDER BY activity ASC
      `)
      .all(protectSince === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : protectSince) as Row[];

    // storedBytes includes index overhead, so scale the content-byte budget by the
    // observed ratio instead of comparing the two directly.
    const overhead = usage.storedBytes / Math.max(usage.contentBytes, 1);
    let contentBudget = usage.contentBytes - targetStoredBytes / overhead;
    const doomed: string[] = [];
    for (const candidate of candidates) {
      if (contentBudget <= 0) break;
      doomed.push(String(candidate.session_key));
      contentBudget -= Number(candidate.bytes);
    }
    // Whatever is left owing after every unprotected session has been taken is
    // held by sessions this pass refuses to touch.
    const reachedTarget = contentBudget <= 0;
    if (doomed.length === 0) return { sessions: 0, messages: 0, reachedTarget };

    const statement = this.db.prepare("DELETE FROM session_messages WHERE session_key = ?");
    // The watermark has to come back with the text. Left alone it would keep
    // reporting the evicted messages as synced and complete, which both misleads
    // the reader and makes the session ineligible for backfill once space frees up.
    const resetWatermark = this.db.prepare(`
      UPDATE session_transcript_sync
      SET cursor = NULL, last_seq = NULL, last_message_id = NULL,
          synced_count = 0, synced_bytes = 0, complete = 0
      WHERE session_key = ?
    `);
    let messages = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sessionKey of doomed) {
        messages += Number(statement.run(sessionKey).changes);
        resetWatermark.run(sessionKey);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.compactIndex();
    return { sessions: doomed.length, messages, reachedTarget };
  }

  /**
   * Drops the transcripts of sessions that are being deleted.
   *
   * `session_messages` carries no foreign key — the FTS triggers need the row to
   * still be there when they fire — so nothing removes these rows on its own.
   * Left behind they would be unreachable through any session view yet still
   * answer searches, which is text outliving the record it belongs to.
   */
  dropSessions(sessionKeys: readonly string[]): number {
    if (sessionKeys.length === 0) return 0;
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      removed = this.dropSessionsInTransaction(sessionKeys);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (removed > 0) this.compactIndex();
    return removed;
  }

  /**
   * The delete without the transaction, for a caller that owns one.
   *
   * Session retention deletes transcripts, session rows and the Activity
   * references that point at them; those have to land together or not at all, so
   * the transaction has to belong to the caller. The FTS compaction is index
   * maintenance rather than part of that atomicity, and is the caller's to run
   * after committing.
   */
  dropSessionsInTransaction(sessionKeys: readonly string[]): number {
    let removed = 0;
    // Chunked to stay clear of the bound-parameter ceiling on a large prune.
    for (let index = 0; index < sessionKeys.length; index += 500) {
      const chunk = sessionKeys.slice(index, index + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      removed += Number(
        this.db.prepare(`DELETE FROM session_messages WHERE session_key IN (${placeholders})`).run(...chunk).changes,
      );
    }
    return removed;
  }

  /**
   * Deletes every archived message and rebuilds the index. The caller is
   * responsible for the VACUUM and for removing migration backups, which also
   * contain transcript text.
   */
  purgeAll(): number {
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      removed = Number(this.db.prepare("DELETE FROM session_messages").run().changes);
      this.db.prepare("UPDATE session_transcript_sync SET cursor = NULL, last_seq = NULL, last_message_id = NULL, synced_count = 0, synced_bytes = 0, complete = 0").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("INSERT INTO session_messages_fts(session_messages_fts) VALUES('rebuild')");
    return removed;
  }
}
