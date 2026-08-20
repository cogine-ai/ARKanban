import { describe, expect, it } from "vitest";
import { classifyCliCommand, parsePsOutput, cliProcessToActivity } from "./standalone-cli.js";

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
    });
  });
});
