# V1 implementation status

This report distinguishes implemented behavior from code paths that require interactive Electron/media testing. The repository was built without launching Electron at the user's request.

## Monorepo

```text
apps/desktop          Electron main, preload, React renderer, custom NLE UI
packages/core         deterministic project model, commands, history, serialization
packages/engine       Mediabunny sources, playback clock/runtime, Web Audio, WebGPU
packages/protocol     Zod contracts, dispatcher, queries, events, structured errors
packages/ui           Base UI + CVA reusable primitives
tools/cli             filesystem adapter and cinesim/video command
tools/mcp             official MCP SDK stdio adapter
docs                  decisions, format, licenses, implementation status
```

## Selected versions

The lockfile pins the complete graph. Direct toolchain/runtime selections are:

- pnpm 11.22.0, Vite+ 0.2.9, Vite 8.2.2, TypeScript 7.0.2
- Electron 43.4.1, electron-builder 26.15.3
- React/React DOM 19.2.8, React Compiler through `@vitejs/plugin-react` 6.1.0 and `oxc-transform-react` 0.145.0
- Tailwind CSS 4.3.3, Base UI 1.7.0, CVA 0.7.1, tailwind-merge 3.6.0, Lucide React 1.33.0
- dnd-kit 6.3.1/10.0.0, Zustand 5.0.15, TanStack Router 1.170.31, Lexical 0.49.0
- Mediabunny 1.55.2, Zod 4.4.3, MCP SDK 1.30.0

## Build workflow

Vite+ owns root tasks, checks, tests, caching, and package-aware execution. The desktop has one mode-aware Vite config because Electron main, preload, and renderer have different targets. `electron-vite` was not added: direct Vite builds avoid a second opinionated integration layer and keep the Vite+ version authoritative.

`vp run desktop:build` produces main ESM, sandboxed preload CJS, and the browser renderer. `vp run desktop:dev` watches those targets, starts one Vite dev server, then starts Electron. The small launcher coordinates processes only.

## Project files

Canonical, Git-tracked state:

- `cinesim.json`: small versioned entry point
- `.cinesim/assets.json`: external media references and metadata
- `.cinesim/timeline.json`: sequences, tracks, clips, transforms, integer-microsecond timing
- `.cinesim/settings.toml`: human-readable preview, autosave, and perception preferences
- `AGENTS.md`: project-specific creative/agent direction

Generated local state is entirely under ignored `.video/{cache,proxies,thumbnails,waveforms,filmstrips,frames,runtime}`. Project creation writes this layout and a project-level `.gitignore`. Canonical saves validate and split state, pretty-print deterministically, write temporary files, and atomically rename them.

## Command and history architecture

The only edit semantics are core commands: asset import and clip add, remove, move, trim start/end, and split. Protocol validates inputs and delegates to core. Desktop, CLI, and MCP use that dispatcher. Stable IDs are deterministically allocated from existing IDs. The desktop keeps immutable snapshots per committed operation for undo/redo; pointer movement is ephemeral and a completed gesture commits one command.

## Media and playback architecture

Main-process metadata reads use Mediabunny `Input` + `FilePathSource`. Renderer decode uses `Input` + `UrlSource` + `VideoSampleSink` through an asset-ID custom protocol supporting bounded byte ranges. The renderer never receives raw paths or unrestricted filesystem APIs.

The monotonic playback clock resolves active timeline layers and source timestamps. A latest-generation controller discards obsolete scrub results. Upcoming clips within the prewarm window call `prepare()` before a cut. Replaced samples and presented `VideoFrame` objects are explicitly closed.

The WebGPU compositor imports each `VideoFrame` with `GPUDevice.importExternalTexture`, applies WGSL position/scale/opacity, supports ordered layers, and submits directly to a `GPUCanvasContext`. It resizes explicitly and reinitializes after device loss.

Audio uses Mediabunny `AudioBufferSink`. A Web Audio scheduler anchors timeline microseconds to `AudioContext.currentTime`, schedules short rolling windows, stops on pause/seek, and reschedules across clip boundaries. AudioWorklet is deferred pending profiling.

## Desktop UI

Implemented surfaces include project create/open, media import/bin, double-click add to timeline, WebGPU viewer transport/scrubber, multi-track custom timeline, dnd-kit clip movement, pointer edge trims, selection/blade tools, split/delete, inspector, Lexical working-notes surface, undo/redo/save/reveal controls, and a throttled runtime metrics overlay. Zustand stores only ephemeral UI state; canonical project snapshots remain outside it.

The Edit workspace has persistent splitters for the Media Pool, Inspector, Notes, and Timeline. Media Pool, Inspector, and Notes visibility and final panel sizes are stored per project in the desktop's noncanonical UI state; resize movement does not write project files or create undo history.

The desktop also has independently resizable, animated left and agent sidebars whose open state and width survive reloads. The settings destination replaces the project navigation with settings sections, including an Agents page for local Claude Code and Codex discovery, login status, executable paths, models, approval modes, and the default provider.

## Local agents

Agent chats use the user's installed Claude Code or Codex executable and persist normalized transcripts outside the canonical project. Claude runs through its streaming JSON protocol; Codex runs through the `app-server` JSON-RPC protocol. Provider-specific events are normalized before they reach React, so the sidebar can render messages, reasoning, tool progress, approval requests, errors, completion, and provider-reported context-window usage consistently. The composer exposes functional per-session model and reasoning-effort controls, next-turn timeline context, and a context-remaining breakdown without estimating data a provider did not report; approval defaults remain in Agents settings.

Each provider receives a session-scoped, bearer-authenticated loopback MCP endpoint. The embedded MCP server is owned by Electron main and delegates inspection and timeline edits to the already-open `DesktopProjectStore`; it does not create a second writer or duplicate editing semantics. Supervised mode asks in the Cinesim UI before canonical edits, while auto-edit mode allows the same validated commands without the prompt. One mutating agent may run per project at a time.

Every agent turn captures canonical state before and after the turn with Git plumbing in ignored `.video/runtime/agent-checkpoints.git`. This does not require a worktree and never adds media. The UI shows the canonical diff stat and can restore the before-turn checkpoint; restoring also reloads the project and starts a fresh provider context on the next message.

## CLI and MCP

The CLI is exposed as both `cinesim` and the specification's temporary `video` alias. Inspect commands support `--json`. Clip editing accepts stable IDs and human time strings and persists through the common dispatcher.

The MCP stdio server exposes project/asset/timeline inspection, clip add/move/trim/split/delete, and derived filmstrip/frame lookup with concise structured content. `CINESIM_PROJECT` selects the project directory for both adapters.

## Verification performed

- TypeScript whole-repository check: passed
- Vite+ format and lint check: passed with no warnings
- Semantic tests, including agent settings persistence, Git checkpoint capture/restore, structured Claude/Codex runtime parsing, authenticated MCP tools, and sidebar shortcuts: passed
- Vite production builds for main, preload, and renderer: passed
- CLI help smoke check: passed
- Electron application launch: intentionally not run

Tests cover command semantics, invalid edits/overlaps, stable ID allocation, undo/redo, deterministic serialization and version rejection, protocol errors, timeline-to-source mapping, monotonic timing, stale-seek coalescing, and sparse perception sampling.

## Performance measurements

No FPS, decode, GPU, seek, or memory measurements are reported. Measuring them requires launching Electron with representative 1080p30, 1080p60, and 4K30 media, which was explicitly left to the user. The debug overlay has counters for the first profiling pass.

## Known limitations and deviations

- Electron/WebCodecs/WebGPU/Web Audio behavior is compiled but not interactively verified.
- Filmstrip and exact-frame CLI/MCP tools currently report deterministic derived paths and availability; actual image generation/writing is not yet connected.
- No proxy encoder, dedicated media worker, or waveform generator is implemented.
- Audio scheduling is a V1 rolling Web Audio buffer path, not an AudioWorklet mixer.
- Audio embedded in a video clip follows that clip; linked/unlinked A/V editing is not modeled.
- The Lexical notes surface is a working draft surface but does not write `AGENTS.md` or `script.md`.
- V1 supports one active flat sequence, rejects overlaps per track, and has no transitions, nested timelines, keyframes, export/render, or cloud features.
- Renderer output is currently a single large application chunk (about 1.05 MB minified); lazy route/vendor splitting is pending.
- The embedded agent MCP bridge shares Electron main's single project writer, but concurrent desktop and external CLI/stdio-MCP writes do not yet use a cross-process project lock or desktop file watcher.
- Local provider integration currently targets Claude Code's streaming JSON protocol and Codex's `app-server` protocol. Compatibility still depends on the installed CLI version and requires interactive desktop validation against each provider.

## Highest-value next steps

1. Run the media validation matrix, fix any platform codec/GPU findings, and capture honest playback/seek/memory metrics.
2. Connect sparse filmstrip/frame generation and waveform jobs to cancellable workers that write `.video/` artifacts.
3. Add cross-process project locking/file watching, then exercise desktop ↔ CLI ↔ MCP live synchronization in integration tests.
