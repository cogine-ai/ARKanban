import { describe, expect, it } from "vitest";
import type { ActivityWrite } from "../activity/projector.js";
import type { CollectorRepository } from "../storage/repository.js";
import {
  classifyCliCommand,
  parsePsOutput,
  cliProcessToActivity,
  StandaloneCliSynchronizer,
  type ObservedCliProcess,
} from "./standalone-cli.js";

describe("standalone CLI observation", () => {
  it("classifies direct and node-wrapped binaries", () => {
    expect(classifyCliCommand("claude", "claude --resume")).toBe("claude");
    expect(classifyCliCommand("/usr/local/bin/codex", "codex exec")).toBe("codex");
    expect(classifyCliCommand("node", "node /opt/bin/claude")).toBe("claude");
    expect(classifyCliCommand("bash", "bash -c claude")).toBeUndefined();
  });

  it("parses ps output into observed processes", () => {
    const processes = parsePsOutput(`
  11 claude claude --print
  22 /usr/bin/codex codex
  33 node node /opt/claude
  44 bash bash -lc echo
`);
    expect(processes.map((process) => process.kind)).toEqual(["claude", "codex", "claude"]);
  });

  it("projects a live attempt activity", () => {
    const write = cliProcessToActivity(
      { pid: 42, kind: "claude", command: "claude", args: "claude --resume" },
      1_000,
    );
    expect(write).toMatchObject({
      origin: "standalone_cli",
      agentId: "cli:claude",
      runtime: "claude-code",
      state: "active",
      sourceKey: "standalone_cli:claude:42",
      title: "claude CLI #42",
    });
    expect(write.title).not.toContain("--resume");
  });

  it("keeps firstSeen across polls so duration is not near zero", async () => {
    const writes: ActivityWrite[] = [];
    const repository = {
      upsertMany: (items: ActivityWrite[]) => {
        writes.push(...items);
        return { ids: items.map((item) => item.id) };
      },
    };
    let processes: ObservedCliProcess[] = [
      { pid: 9, kind: "codex", command: "codex", args: "codex --please-ignore-this-secret" },
    ];
    const syncer = new StandaloneCliSynchronizer(repository as unknown as CollectorRepository, {
      enabled: true,
      listProcesses: async () => processes,
    });

    await syncer.sync(1_000);
    await syncer.sync(6_000);
    processes = [];
    await syncer.sync(20_000);

    const live = writes.filter((item) => item.state === "active");
    const terminal = writes.find((item) => item.state === "terminal");
    expect(live.every((item) => item.startedAt === 1_000)).toBe(true);
    expect(terminal).toMatchObject({ startedAt: 1_000, endedAt: 20_000 });
  });

  it("does not write once stop() has closed the repository", async () => {
    let resolveList!: (value: ObservedCliProcess[]) => void;
    const pending = new Promise<ObservedCliProcess[]>((resolve) => {
      resolveList = resolve;
    });
    const writes: ActivityWrite[] = [];
    const syncer = new StandaloneCliSynchronizer(
      {
        upsertMany: (items: ActivityWrite[]) => {
          writes.push(...items);
          return { ids: items.map((item) => item.id) };
        },
      } as unknown as CollectorRepository,
      {
        enabled: true,
        listProcesses: () => pending,
      },
    );
    const done = syncer.sync(1_000);
    syncer.stop();
    resolveList([{ pid: 1, kind: "claude", command: "claude", args: "" }]);
    expect(await done).toBe(0);
    expect(writes).toEqual([]);
  });

  it("swallows poll errors after stop so the closed repository is not touched", async () => {
    const syncer = new StandaloneCliSynchronizer({} as CollectorRepository, {
      enabled: true,
      listProcesses: async () => {
        throw new Error("ps failed");
      },
    });
    expect(await syncer.sync(1_000)).toBe(0);
  });
});
