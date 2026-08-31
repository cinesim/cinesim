# Cinesim engineering invariants

Cinesim is a local-first, agent-native nonlinear video editor. Keep the system small, deterministic, inspectable, and safe.

1. `packages/core` cannot depend on Electron, React, DOM, WebGPU, WebCodecs, Mediabunny, Node filesystem APIs, MCP, or CLI code.
2. The UI never writes canonical project files directly.
3. Every canonical edit goes through a validated command.
4. CLI and MCP are adapters; they contain no duplicate editing semantics.
5. React does not drive playback or store decoded frames.
6. Mediabunny is the container/media abstraction and WebCodecs is the primary decode path.
7. WebGPU is the primary compositor. Canvas2D is allowed only for derived perception artifacts, never normal preview composition.
8. Canonical project state is `cinesim.toml` plus its reachable `.js`/`.jsx` video source modules. Generated media is under `.video/` and must remain disposable.
9. Canonical serialization must be deterministic, pretty printed, versioned, and free from timestamps that churn Git diffs.
10. Do not casually add dependencies. Verify the license first and update `docs/internals/dependencies.mdx` for runtime dependencies.
11. Preserve third-party notices. Mediabunny remains MPL-2.0; Cinesim's own source remains MIT.
12. Never move decoded frames through Electron IPC per presentation frame.
13. Never load complete large media files into memory, serialize media as base64, or retain unbounded `VideoFrame` collections.
14. Keep Electron `nodeIntegration: false`, `contextIsolation: true`, sandboxing enabled, and expose only narrow validated preload methods.
15. Do not add speculative cloud abstractions in V1.
16. A drag/trim gesture creates one committed command and one undo step; do not persist every pointer movement.
17. Run `vp run verify:fast` and the relevant build tasks before completing changes. Use `vp run verify` for the complete static CI gate. These commands do not launch Electron; do not run `vp run desktop:dev` when the task prohibits launching it.
18. Do not use the built-in browser skill in this workspace.
19. Bun is the only package manager, but Node.js remains the application runtime. Manage dependencies through `vp install`, `vp add`, and `vp remove`; do not introduce another package manager's lockfile or commands.
20. Keep shared commands in the root Vite+ task graph (`vite.config.ts`). Package scripts may provide implementation details, but documentation, CI, Conductor, and agent workflows should call the stable `vp run ...` tasks.

## Standard commands

- `vp install --frozen-lockfile` installs the exact dependency graph from `bun.lock`.
- `vp run desktop:dev` starts the ordinary local-only desktop development process.
- `vp run api:setup` prepares optional local account services; `vp run local:dev` starts the complete local stack.
- `vp run verify:fast` runs formatting, linting, repository and web type checks, and tests.
- `vp run build:all` builds the desktop bundles, API browser bundle, and web app.
- `vp run verify` runs the complete noninteractive CI gate.

## Development diagnostics

- Node-side diagnostics are written to `.context/logs/` as local NDJSON during development; diagnostic queries are bounded.
- Use `vp exec -- tsx tools/diagnostics.ts --errors` for a concise recent failure report.
- Use `vp exec -- tsx tools/diagnostics.ts --errors --json` for structured output.
- Keep logs off MCP stdout; MCP protocol output belongs on stdout and diagnostics belong on stderr/files.
