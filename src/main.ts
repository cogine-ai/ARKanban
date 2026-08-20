#!/usr/bin/env node
import { CollectorRuntime } from "./collector/runtime.js";
import { isLoopbackHost, loadConfig, redactEndpoint, transcriptNotice } from "./config.js";
import { createHttpServer } from "./http/server.js";
import { HubRuntime } from "./hub/runtime.js";
import { purgeTranscripts } from "./storage/purge-transcripts.js";

const COMMANDS = ["start", "check", "version", "purge-transcripts"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): string {
  return [
    "OpenClaw Collector 0.1.0",
    "",
    "Usage:",
    "  openclaw-collector start [--config path]",
    "  openclaw-collector check [--config path]",
    "  openclaw-collector purge-transcripts [--config path] --yes",
    "  openclaw-collector version",
  ].join("\n");
}

function parseArguments(argv: string[]): { command: Command; configPath: string; confirmed: boolean } {
  const command = (argv[0] ?? "start") as Command;
  if (!COMMANDS.includes(command)) throw new Error(usage());
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : "collector.config.json";
  if (!configPath) throw new Error("--config requires a path");
  return { command, configPath, confirmed: argv.includes("--yes") };
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "version") {
    process.stdout.write("0.1.0\n");
    return;
  }

  const config = loadConfig(args.configPath, process.env, {
    requireToken: args.command !== "purge-transcripts",
  });

  if (args.command === "purge-transcripts") {
    // Irreversible and unprompted-for: without an explicit flag this would be a
    // one-keystroke way to destroy the archive from a script.
    if (!args.confirmed) {
      throw new Error("purge-transcripts deletes every archived transcript. Re-run with --yes to confirm.");
    }
    const result = purgeTranscripts(config.storage.path);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.vacuumed) {
      // The rows and the backups are gone, but the pages that held them were not
      // rewritten. Reporting this as success would leave the operator believing
      // in an erasure that is still incomplete.
      process.stderr.write(
        "warning: freed pages were not rewritten, so deleted text may remain recoverable in the database file. " +
          "Stop the collector and re-run to finish.\n",
      );
      process.exitCode = 3;
    }
    return;
  }

  const collectsLocally = config.role === "node" || config.role === "both";
  const runsHub = config.role === "hub" || config.role === "both";

  if (args.command === "check") {
    if (!collectsLocally) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, role: config.role, hubsNodes: config.hub.nodes.length }, null, 2)}\n`,
      );
      return;
    }
    const runtime = new CollectorRuntime(config);
    try {
      const hello = await runtime.checkConnection(10_000);
      const methods = new Set(hello.features.methods);
      const support = {
        "tasks.list": methods.has("tasks.list"),
        "sessions.list": methods.has("sessions.list"),
        "sessions.subscribe": methods.has("sessions.subscribe"),
      };
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: Object.values(support).every(Boolean),
            host: config.host,
            endpoint: redactEndpoint(config.gateway.url),
            serverVersion: hello.server.version,
            protocol: hello.protocol,
            grantedScopes: hello.auth?.scopes ?? [],
            methods: support,
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = Object.values(support).every(Boolean) ? 0 : 2;
    } finally {
      await runtime.stop();
    }
    return;
  }

  // Hub-only: fan-in UI. Node / both: local collector (both also starts hub fan-in
  // in the same process via HubRuntime listing remotes; local data stays on the
  // node HTTP surface when role is both — use role hub on a machine that only
  // aggregates, or open the hub host's UI).
  const surface =
    runsHub && !collectsLocally
      ? new HubRuntime(config)
      : collectsLocally
        ? new CollectorRuntime(config)
        : new HubRuntime(config);

  // When role is both, prefer serving the local node board on this port and run
  // a companion hub only if remotes are configured — operators open a dedicated
  // hub process for the merged view. Local collection always wins here.
  if (runsHub && collectsLocally && config.hub.nodes.length > 0) {
    process.stdout.write(
      `role=both: serving local node on this port; configure a separate hub process to fan-in remotes (${config.hub.nodes.length} listed)\n`,
    );
  }

  const app = await createHttpServer(surface, config);
  await app.listen({ host: config.server.host, port: config.server.port });
  surface.start();

  const bindNote = isLoopbackHost(config.server.host)
    ? "loopback"
    : `LAN (token via ${config.server.tokenEnv ?? "server.tokenEnv"})`;
  process.stdout.write(
    `OpenClaw Collector listening on http://${config.server.host}:${config.server.port} [${config.role}/${bindNote}] host=${config.host.id}\n`,
  );
  if (collectsLocally) {
    process.stdout.write(`Gateway ${redactEndpoint(config.gateway.url)}\n`);
    process.stdout.write(transcriptNotice(config));
    if (config.localSources.standaloneCli === "enabled") {
      process.stdout.write("Standalone CLI observation: on (claude / codex processes)\n");
    }
  }
  if (surface instanceof HubRuntime) {
    process.stdout.write(`Hub fan-in nodes: ${config.hub.nodes.map((node) => node.id).join(", ") || "(none)"}\n`);
  }

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Stopping Collector after ${signal}\n`);
    await surface.stop();
    await app.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
