#!/usr/bin/env node
import { CollectorRuntime } from "./collector/runtime.js";
import { loadConfig, redactEndpoint } from "./config.js";
import { createHttpServer } from "./http/server.js";

type Command = "start" | "check" | "version";

function usage(): string {
  return [
    "OpenClaw Collector 0.1.0",
    "",
    "Usage:",
    "  openclaw-collector start [--config path]",
    "  openclaw-collector check [--config path]",
    "  openclaw-collector version",
  ].join("\n");
}

function parseArguments(argv: string[]): { command: Command; configPath: string } {
  const command = (argv[0] ?? "start") as Command;
  if (!(["start", "check", "version"] as const).includes(command)) throw new Error(usage());
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : "collector.config.json";
  if (!configPath) throw new Error("--config requires a path");
  return { command, configPath };
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "version") {
    process.stdout.write("0.1.0\n");
    return;
  }

  const config = loadConfig(args.configPath);
  const runtime = new CollectorRuntime(config);
  if (args.command === "check") {
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

  const app = await createHttpServer(runtime, config);
  await app.listen({ host: config.server.host, port: config.server.port });
  runtime.start();
  process.stdout.write(
    `OpenClaw Collector listening on http://${config.server.host}:${config.server.port} (Gateway ${redactEndpoint(config.gateway.url)})\n`,
  );

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Stopping Collector after ${signal}\n`);
    await runtime.stop();
    await app.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
