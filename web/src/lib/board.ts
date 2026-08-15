import type {
  ActivityItem,
  ActivityStage,
  SettledGroupSummary,
  SettledPriorityTier,
  UpcomingSchedule,
} from "../../../src/contracts";

export type KindFilter = "all" | "task" | "attempt";

export type AgentBoardRow = {
  agentId: string;
  items: ActivityItem[];
  schedules: UpcomingSchedule[];
  groups: SettledGroupSummary[];
};

export const OPERATIONAL_STAGES: Array<{
  key: Exclude<ActivityStage, "settled" | "unresolved">;
  label: string;
  hint: string;
  arrow: string;
}> = [
  { key: "incoming", label: "INCOMING", hint: "queued now · scheduled next 1h", arrow: "→" },
  { key: "in_flight", label: "IN FLIGHT", hint: "observed execution", arrow: "→" },
  { key: "waiting", label: "WAITING", hint: "operator attention", arrow: "↔" },
];

export const AGENT_COLORS = ["#39766e", "#bd6842", "#53679c", "#aa8738", "#8c657f", "#758653", "#517f87", "#815d45"];

export const PRIORITY_ORDER: Record<SettledPriorityTier, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const SERIES_TONE: Record<SettledPriorityTier, string> = {
  P0: "border-red-300/80 bg-red-50/95 text-red-950",
  P1: "border-slate-300/90 bg-slate-50/95 text-slate-900",
  P2: "border-amber-300/80 bg-amber-50/95 text-amber-950",
  P3: "border-emerald-200/90 bg-emerald-50/80 text-emerald-950",
};
