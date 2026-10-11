import { describe, expect, it } from "vitest";
import type { ActivityItem, ActivityRelation } from "../../../src/contracts";
import { buildRelationsModel } from "./relations-model";

function activity(id: string, patch: Partial<ActivityItem> = {}): ActivityItem {
  return { id, hostId: "desk", agentId: "writer", kind: "task", origin: "task_ledger", catalog: "operational", state: "active", outcome: "none", phase: "model", attention: "none", stage: "in_flight", freshness: "live", title: id, updatedAt: 1, lastObservedAt: 1, evidence: [], ...patch };
}
function link(from: string, to: string, type: ActivityRelation["type"] = "run_correlation"): ActivityRelation {
  return { from, to, type, certainty: type === "parent_task" ? "exact" : "correlation_only", label: type === "parent_task" ? "parent task" : "shared run reference" };
}

describe("relation evidence groups", () => {
  it("keeps a many-to-many run in one container with four links and four distinct objects", () => {
    const items = [activity("task-a"), activity("task-b"), activity("attempt-a", { kind: "attempt" }), activity("attempt-b", { kind: "attempt" })];
    const links = [link("task-a", "attempt-a"), link("task-a", "attempt-b"), link("task-b", "attempt-a"), link("task-b", "attempt-b")];
    const model = buildRelationsModel(items, [...links, links[0]!]);
    expect(model.shared.groups).toHaveLength(1);
    expect(model.shared.groups[0]?.nodes).toHaveLength(4);
    expect(model.shared.groups[0]?.links).toHaveLength(4);
    expect(model.shared.linkCount).toBe(4);
    expect(model.shared.groups[0]?.rows).toEqual([]);
  });

  it("uses only exact parent links for ordered tree levels, independently from shared runs", () => {
    const items = ["a", "b", "c", "d"].map((id) => activity(id));
    const model = buildRelationsModel(items, [link("a", "b", "parent_task"), link("b", "c", "parent_task"), link("a", "d", "parent_task"), link("a", "c")]);
    expect(model.parent.groups[0]?.rows.map((row) => [row.node.id, row.depth])).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 1]]);
    expect(model.parent.groups[0]?.rows.map((row) => [row.node.id, row.continues, row.ancestorBranches])).toEqual([["a", false, []], ["b", true, []], ["c", false, [1]], ["d", false, []]]);
    expect(model.parent.linkCount).toBe(3);
    expect(model.shared.groups[0]?.nodes.map((node) => node.id)).toEqual(["a", "c"]);
  });

  it("preserves host-qualified local names and never merges equal local IDs across hosts", () => {
    const items = [activity("a::task", { hostId: "a" }), activity("a::attempt", { hostId: "a", kind: "attempt" }), activity("b::task", { hostId: "b" }), activity("b::attempt", { hostId: "b", kind: "attempt" })];
    const model = buildRelationsModel(items, [link("a::task", "a::attempt"), link("b::task", "b::attempt"), link("a::task", "b::attempt")]);
    expect(model.shared.groups).toHaveLength(2);
    expect(model.shared.unresolved.map((entry) => entry.reason)).toEqual(["Cross-host link"]);
    expect(model.shared.linkCount).toBe(3);
  });

  it("retains missing endpoints and ambiguous local identity without choosing an arbitrary host", () => {
    const items = [activity("same", { hostId: "a" }), activity("same", { hostId: "b" }), activity("known")];
    const model = buildRelationsModel(items, [link("known", "missing"), link("same", "known")]);
    expect(model.shared.groups).toEqual([]);
    expect(model.shared.unresolved.map((entry) => entry.reason)).toEqual(["Missing record", "Ambiguous identity"]);
    expect(model.shared.unresolved[0]?.from.item?.id).toBe("known");
    expect(model.shared.unresolved[0]?.to.item).toBeUndefined();
    expect(model.shared.unresolved[1]?.from.item).toBeUndefined();
  });

  it.each([
    ["Cycle", [link("a", "b", "parent_task"), link("b", "a", "parent_task")]],
    ["Cycle", [link("a", "a", "parent_task")]],
    ["Multiple parents", [link("a", "c", "parent_task"), link("b", "c", "parent_task")]],
  ] as const)("does not draw %s as a parent tree", (reason, links) => {
    const model = buildRelationsModel(["a", "b", "c"].map((id) => activity(id)), [...links]);
    expect(model.parent.groups).toEqual([]);
    expect(model.parent.unresolved).toHaveLength(links.length);
    expect(model.parent.unresolved.every((entry) => entry.reason === reason)).toBe(true);
  });

  it("keeps unverified and unimplemented relation types available without inventing a tree", () => {
    const relation = { ...link("a", "b", "parent_task"), certainty: "correlation_only" as const };
    const model = buildRelationsModel([activity("a"), activity("b")], [relation, link("a", "b", "session_lineage")]);
    expect(model.parent.groups).toEqual([]);
    expect(model.parent.unresolved[0]?.reason).toBe("Unverified parent");
    expect(model.other[0]?.relation.type).toBe("session_lineage");
  });

  it("handles a deep 600-object tree without recursive rendering or losing identities", () => {
    const items = Array.from({ length: 600 }, (_, index) => activity(String(index).padStart(3, "0")));
    const links = items.slice(1).map((item, index) => link(items[index]!.id, item.id, "parent_task"));
    const model = buildRelationsModel(items, links);
    expect(model.parent.groups).toHaveLength(1);
    expect(model.parent.groups[0]?.rows).toHaveLength(600);
    expect(model.parent.groups[0]?.rows.at(-1)?.depth).toBe(599);
  });
});
