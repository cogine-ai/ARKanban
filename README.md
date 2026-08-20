# AR Kanban

AR Kanban is a read-only live activity board for a single OpenClaw Gateway, powered by the OpenClaw Collector runtime. It combines authoritative task and session snapshots, a next-hour Cron forecast, and low-latency events; operational history stays in a bounded local SQLite projection and the Gateway connection uses `operator.read` only.

![Implemented dense Live Flow](docs/v1/openclaw-collector-v1-implementation-dense.png)

## Quick start

Requirements: Node.js 22.16+, pnpm 10, and a running OpenClaw Gateway using token authentication.

```bash
git clone https://github.com/cogine-ai/ARKanban.git
cd ARKanban
pnpm install --frozen-lockfile
cp collector.config.example.json collector.config.json
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token"
pnpm check
pnpm build
pnpm start
```

`pnpm check` must return `"ok": true`. If your Gateway does not use the default `ws://127.0.0.1:18789`, update `collector.config.json` first. The token must match the Gateway's `gateway.auth.token` or `OPENCLAW_GATEWAY_TOKEN`.

Open `http://127.0.0.1:47123`.

Collector listens on loopback. To view it from another computer, forward the port and then open the same URL locally:

```bash
ssh -N -L 47123:127.0.0.1:47123 user@gateway-host
```

## Multi-host (node + hub)

Each machine runs a **node** that still talks only to its local OpenClaw Gateway. One machine (or a dedicated host) runs a **hub** that fans in node HTTP/SSE into a single board. Gateway tokens never leave their host.

### In-app Settings (preferred)

Open **Settings** in the UI:

1. Enter this machine's **Gateway token** (stored in `collector.config.secrets.json`, shown only as `••••last4`).
2. On each **node**: set listen host to `0.0.0.0` if hubs on the LAN must reach it, then **生成配对码**.
3. On the **hub**: paste the code + `http://node-ip:47123` under **认领节点**.
4. Restart the collector when Settings says restart is required.

### Manual config file

**Node** (LAN bind requires a shared secret):

```json
{
  "host": { "id": "desk-a", "label": "Desk A" },
  "role": "node",
  "server": { "host": "0.0.0.0", "port": 47123, "tokenEnv": "COLLECTOR_NODE_TOKEN" },
  "localSources": { "standaloneCli": "enabled" }
}
```

**Hub**:

```json
{
  "host": { "id": "hub", "label": "Hub" },
  "role": "hub",
  "hub": {
    "nodes": [
      { "id": "desk-a", "url": "http://192.168.1.10:47123", "tokenEnv": "COLLECTOR_NODE_TOKEN" },
      { "id": "desk-b", "url": "http://192.168.1.11:47123", "tokenEnv": "COLLECTOR_NODE_TOKEN" }
    ]
  }
}
```

Standalone `claude` / `codex` CLI processes on each node are observed locally and appear on the board with `origin: standalone_cli` (OpenClaw-backed harnesses remain Gateway-visible as before).

## Development

```bash
pnpm dev
```

Open `http://127.0.0.1:5173`. The API runs on `http://127.0.0.1:47123`.

## Demo data (optional)

Use the bundled mock when you want to inspect dense layout and live event behavior without creating real OpenClaw work:

```bash
# terminal 1
pnpm mock:gateway

# terminal 2
pnpm demo
```

Open `http://127.0.0.1:47123`. This fixture produces 180 operational records, about 30 waiting attempts, 30 recent terminal records, five next-hour Cron forecasts, and live tool events. Mock data is never used by `check`, `start`, or `dev`.

## What you get

- Live Flow: adaptive-density Agent lanes across Incoming, In Flight, Waiting, and Settled
- Incoming forecast: queued Tasks first, followed by enabled Cron jobs due within the next hour; Cron remains a read-only, non-persisted forecast
- Activity Inspector: current state, observation evidence, identities, timeline, and relations
- Relations: exact parent links and correlation-only run links
- Archive: recent terminal task and attempt projections
- Agents: per-Agent roster cards with 24h/7d outcome rollups, cost, and next-hour schedule, plus a detail page with the full outcome distribution
- Sessions: paged session list with grade, state and cost sorting, and a session detail page with lineage, usage, derived signals, timeline, and the archived conversation
- Connections: Gateway, Task snapshot, Session snapshot, Event stream health, and the transcript archive disclosure
- HTTP API and SSE: `/api/v1/meta`, `/api/v1/snapshot` (including the separate Schedule forecast), `/api/v1/settled-groups`, `/api/v1/activities/:id`, `/api/v1/agents`, `/api/v1/sessions`, `/api/v1/usage/summary`, and `/api/v1/events`
- Operational probes: `/healthz` and `/readyz`

Task ledger records and observed execution attempts are intentionally separate. A generic attempt end remains `outcome: unknown`; Collector only shows success when an authoritative source establishes it.

## Conversation archive (off by default)

Collector can keep the full text of every conversation from your Gateway in the local SQLite database, so sessions stay readable and searchable while the Gateway is offline. **This is off unless you turn it on**, because it changes what the database contains from operational metadata into your actual conversations:

```json
{ "storage": { "transcriptSync": "enabled" } }
```

With it on, every start prints where the text is stored, how long it is kept, and the command to erase it. Defaults are 180 days and 2 GiB, whichever comes first; eviction drops whole sessions oldest-first rather than leaving half a conversation. The text is served only by `/api/v1/sessions/:key/messages` and `/api/v1/search/messages`, never by the snapshot, SSE, logs, or diagnostics, and the Connections page discloses the archive's size while it exists.

To erase it, including the migration backups that also contain text:

```bash
pnpm openclaw-collector purge-transcripts --yes
```

This runs `VACUUM`, so the text is not recoverable from free pages, and it does not require a Gateway token — needing to restore a revoked token before deleting your own local data would be backwards.

## Design package

- [Complete v1 blueprint](docs/v1/openclaw-collector-v1-blueprint.md)
- [Incoming queued Task + next-hour Cron implementation spec](docs/v1/ar-kanban-incoming-cron-implementation-spec.md)
- [Adaptive Settled range, grouping, sorting, and quota spec](docs/v1/ar-kanban-adaptive-board-implementation-spec.md)
- [Interactive Adaptive Activity River prototype](docs/v1/openclaw-collector-v1-adaptive-flowboard-prototype.html)
- [Motion specimen](docs/v1/openclaw-collector-v1-adaptive-flowboard-motion.webm)
- Load specimens: [4 active](docs/v1/openclaw-collector-v1-adaptive-flowboard-sparse-final.png), [180 active](docs/v1/openclaw-collector-v1-adaptive-flowboard-dense-final.png), [600 active](docs/v1/openclaw-collector-v1-adaptive-flowboard-extreme-final.png)

The v1 uses the public OpenClaw Gateway protocol with explicit `operator.read`. The raw protocol adapter is isolated in `src/gateway/adapter.ts` so it can be replaced by an official published Gateway client without changing the collector or UI layers.

Source analysis and code links in the blueprint are pinned to OpenClaw commit `ff73a14f5ae71a899e5db9a3a41718ab1d104517`.

## Status

The v1 MVP and deterministic integration tests are implemented. Protocol v4 compatibility has been verified against OpenClaw 2026.7.1 locally and an isolated OpenClaw 2026.8.1 Gateway. System-service and container packaging are not included yet.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
