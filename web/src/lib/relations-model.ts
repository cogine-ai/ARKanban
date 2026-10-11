import type { ActivityItem, ActivityRelation } from "../../../src/contracts";
import { splitQualifiedId } from "../../../src/host/ids";

export type RelationMode = "parent_task" | "run_correlation";
export type RelationNode = { key: string; id: string; hostId?: string; item?: ActivityItem; missing: boolean; ambiguous: boolean };
export type RelationRow = { node: RelationNode; depth: number; parentKey?: string; continues?: boolean; ancestorBranches?: number[] };
export type RelationGroup = { key: string; hostId: string; nodes: RelationNode[]; links: ActivityRelation[]; rows: RelationRow[] };
export type UnresolvedRelation = { key: string; relation: ActivityRelation; from: RelationNode; to: RelationNode; reason: "Missing record" | "Ambiguous identity" | "Cross-host link" | "Multiple parents" | "Cycle" | "Unverified parent" | "Other relation" };
export type RelationsModel = {
  parent: { groups: RelationGroup[]; unresolved: UnresolvedRelation[]; linkCount: number };
  shared: { groups: RelationGroup[]; unresolved: UnresolvedRelation[]; linkCount: number };
  other: UnresolvedRelation[];
};

export function relationKey(relation: ActivityRelation): string {
  return JSON.stringify([relation.type, relation.from, relation.to, relation.certainty]);
}

/** Full host identity is kept even when a node speaks unqualified local IDs. */
export function relationNodeKey(item: Pick<ActivityItem, "id" | "hostId">): string {
  return JSON.stringify([item.hostId, item.id]);
}

function compareNodes(a: RelationNode, b: RelationNode): number {
  return a.key.localeCompare(b.key);
}

/**
 * Relations are evidence. A shared run is an undirected component, while only
 * an exact, same-host, acyclic single-parent component is rendered as a tree.
 * Invalid edges remain available without creating a fictitious hierarchy.
 */
export function buildRelationsModel(items: ActivityItem[] = [], relations: ActivityRelation[] = []): RelationsModel {
  const itemsById = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const matches = itemsById.get(item.id) ?? [];
    if (!matches.some((existing) => relationNodeKey(existing) === relationNodeKey(item))) matches.push(item);
    itemsById.set(item.id, matches);
  }
  const unique = [...new Map(relations.map((relation) => [relationKey(relation), relation])).values()];
  const result: RelationsModel = { parent: { groups: [], unresolved: [], linkCount: 0 }, shared: { groups: [], unresolved: [], linkCount: 0 }, other: [] };

  const endpoint = (id: string): RelationNode => {
    const matches = itemsById.get(id) ?? [];
    const item = matches.length === 1 ? matches[0] : undefined;
    return { key: item ? relationNodeKey(item) : JSON.stringify(["unresolved", id]), id, hostId: item?.hostId ?? splitQualifiedId(id)?.hostId, item, missing: matches.length === 0, ambiguous: matches.length > 1 };
  };

  for (const mode of ["parent_task", "run_correlation"] as const) {
    const target = mode === "parent_task" ? result.parent : result.shared;
    const edges = unique.filter((relation) => relation.type === mode);
    target.linkCount = edges.length;
    const goodEdges: { relation: ActivityRelation; from: RelationNode; to: RelationNode }[] = [];
    for (const relation of edges) {
      const from = endpoint(relation.from);
      const to = endpoint(relation.to);
      const reason = from.ambiguous || to.ambiguous ? "Ambiguous identity"
        : from.missing || to.missing ? "Missing record"
        : from.hostId !== to.hostId ? "Cross-host link"
        : mode === "parent_task" && relation.certainty !== "exact" ? "Unverified parent" : undefined;
      if (reason) target.unresolved.push({ key: relationKey(relation), relation, from, to, reason });
      else goodEdges.push({ relation, from, to });
    }

    const nodes = new Map<string, RelationNode>();
    const neighbors = new Map<string, Set<string>>();
    const edgeKeysByNode = new Map<string, number[]>();
    goodEdges.forEach((edge, index) => {
      for (const [node, neighbor] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
        nodes.set(node.key, node);
        const related = neighbors.get(node.key) ?? new Set<string>();
        related.add(neighbor.key);
        neighbors.set(node.key, related);
        const indexes = edgeKeysByNode.get(node.key) ?? [];
        indexes.push(index);
        edgeKeysByNode.set(node.key, indexes);
      }
    });

    const visited = new Set<string>();
    for (const seed of [...nodes.keys()].sort()) {
      if (visited.has(seed)) continue;
      const componentKeys: string[] = [];
      const componentEdges = new Set<number>();
      const queue = [seed];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const key = queue[cursor]!;
        if (visited.has(key)) continue;
        visited.add(key);
        componentKeys.push(key);
        for (const index of edgeKeysByNode.get(key) ?? []) componentEdges.add(index);
        for (const neighbor of neighbors.get(key) ?? []) if (!visited.has(neighbor)) queue.push(neighbor);
      }
      const component = [...componentEdges].map((index) => goodEdges[index]!);
      const componentNodes = componentKeys.map((key) => nodes.get(key)!).sort(compareNodes);
      const rows: RelationRow[] = [];
      if (mode === "parent_task") {
        const parentCounts = new Map<string, number>();
        const children = new Map<string, RelationNode[]>();
        for (const edge of component) {
          parentCounts.set(edge.to.key, (parentCounts.get(edge.to.key) ?? 0) + 1);
          const descendants = children.get(edge.from.key) ?? [];
          descendants.push(edge.to);
          children.set(edge.from.key, descendants);
        }
        const roots = componentNodes.filter((node) => !parentCounts.has(node.key));
        const multipleParents = [...parentCounts.values()].some((count) => count > 1);
        const treeQueue = roots.map((node) => ({ node, depth: 0 } as RelationRow));
        const treeVisited = new Set<string>();
        // Preorder avoids recursion and retains the parent immediately before its branch.
        while (treeQueue.length > 0) {
          const row = treeQueue.pop()!;
          if (treeVisited.has(row.node.key)) continue;
          treeVisited.add(row.node.key);
          rows.push(row);
          const descendants = (children.get(row.node.key) ?? []).sort(compareNodes);
          for (let index = descendants.length - 1; index >= 0; index -= 1) treeQueue.push({ node: descendants[index]!, depth: row.depth + 1, parentKey: row.node.key });
        }
        if (multipleParents || treeVisited.size !== componentNodes.length) {
          const reason = multipleParents ? "Multiple parents" : "Cycle";
          for (const edge of component) target.unresolved.push({ key: relationKey(edge.relation), ...edge, reason });
          continue;
        }
        const lastChildByParent = new Map<string, string>();
        for (const row of rows) if (row.parentKey) lastChildByParent.set(row.parentKey, row.node.key);
        const activeBranches = new Set<number>();
        for (const row of rows) {
          for (const depth of activeBranches) if (depth >= row.depth) activeBranches.delete(depth);
          row.ancestorBranches = [...activeBranches].sort((a, b) => a - b);
          row.continues = Boolean(row.parentKey && lastChildByParent.get(row.parentKey) !== row.node.key);
          if (row.continues) activeBranches.add(row.depth);
        }
      }
      target.groups.push({ key: JSON.stringify([mode, componentNodes.map((node) => node.key)]), hostId: componentNodes[0]!.hostId!, nodes: componentNodes, links: component.map((edge) => edge.relation), rows });
    }
  }
  result.other = unique.filter((relation) => relation.type !== "parent_task" && relation.type !== "run_correlation").map((relation) => ({ key: relationKey(relation), relation, from: endpoint(relation.from), to: endpoint(relation.to), reason: "Other relation" }));
  return result;
}
