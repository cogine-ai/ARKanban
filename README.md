# OpenClaw Collector

An independent, read-only runtime observer for a single OpenClaw Gateway.

The project is currently at the architecture and interaction-design stage. No production Collector implementation has been started yet.

## v1 design package

- [Complete v1 blueprint](docs/v1/openclaw-collector-v1-blueprint.md)
- [Interactive Adaptive Activity River prototype](docs/v1/openclaw-collector-v1-adaptive-flowboard-prototype.html)
- [Motion specimen](docs/v1/openclaw-collector-v1-adaptive-flowboard-motion.webm)
- Load specimens: [4 active](docs/v1/openclaw-collector-v1-adaptive-flowboard-sparse-final.png), [180 active](docs/v1/openclaw-collector-v1-adaptive-flowboard-dense-final.png), [600 active](docs/v1/openclaw-collector-v1-adaptive-flowboard-extreme-final.png)

The proposed v1 uses the public OpenClaw Gateway protocol with explicit `operator.read`, reconciles authoritative RPC snapshots with low-latency events, stores a privacy-bounded projection in SQLite, and serves an independent read-only web interface.

Source analysis and code links in the blueprint are pinned to OpenClaw commit `ff73a14f5ae71a899e5db9a3a41718ab1d104517`.

## Repository status

- Architecture: frozen for v1 implementation slicing
- Product and interaction design: frozen for the first implementation pass
- Collector backend: not implemented
- Web application: prototype only
