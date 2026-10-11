import type { SessionLineage } from "../../../src/contracts";

export type SessionSourceRelation = "Parent" | "Forked from" | "Spawned by";
export type SessionSourceReference = {
  reference: string;
  relations: SessionSourceRelation[];
  /** Only references that the reported field identifies as a session are queried. */
  lookupKey?: string;
};

const SOURCE_FIELDS = [
  ["parentSessionKey", "Parent"],
  ["forkSourceKey", "Forked from"],
  ["spawnedBy", "Spawned by"],
] as const;

export const LINEAGE_FIELDS = [
  ["parentSessionKey", "Parent session"],
  ["forkSourceKey", "Forked from"],
  ["spawnedBy", "Spawned by"],
  ["previousSessionId", "Previous version"],
  ["spawnDepth", "Depth"],
  ["subagentRole", "Role"],
  ["worktreeBranch", "Worktree"],
] as const;

function reported(value: unknown): value is string | number {
  return typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
}

/** The Gateway's standard session-key form, unlike a spawn role or actor name. */
function looksLikeSessionKey(value: string): boolean {
  return /^agent:[^:\s]+:\S.*$/.test(value);
}

/**
 * The reported one-hop sources only. Depth, a generation ID, and worktree are
 * attributes, never extra ancestors. Multiple fields naming one source remain
 * one node with all of their relationship labels.
 */
export function buildSessionSources(sessionKey: string, lineage: SessionLineage): {
  sources: SessionSourceReference[];
  selfReferences: SessionSourceRelation[];
} {
  const explicitKeys = new Set([lineage.parentSessionKey?.trim(), lineage.forkSourceKey?.trim()].filter(Boolean));
  const sources = new Map<string, SessionSourceReference>();
  const selfReferences: SessionSourceRelation[] = [];
  for (const [field, relation] of SOURCE_FIELDS) {
    const reference = lineage[field]?.trim();
    if (!reference) continue;
    if (reference === sessionKey) {
      selfReferences.push(relation);
      continue;
    }
    const lookupKey = field !== "spawnedBy" || explicitKeys.has(reference) || looksLikeSessionKey(reference)
      ? reference
      : undefined;
    const previous = sources.get(reference);
    if (previous) {
      previous.relations.push(relation);
      if (lookupKey) previous.lookupKey = lookupKey;
    } else {
      sources.set(reference, { reference, relations: [relation], ...(lookupKey ? { lookupKey } : {}) });
    }
  }
  return { sources: [...sources.values()], selfReferences };
}

export function reportedLineageFields(lineage: SessionLineage): Array<{ key: string; label: string; value: string | number }> {
  return LINEAGE_FIELDS.flatMap(([key, label]) => {
    const value = lineage[key];
    return reported(value) ? [{ key, label, value }] : [];
  });
}

export function shortReference(value: string): string {
  return value.length > 38 ? `${value.slice(0, 17)}…${value.slice(-16)}` : value;
}
