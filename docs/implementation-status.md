# V1 implementation status

This report distinguishes implemented behavior from code paths that require interactive Electron/media testing. The repository was built without launching Electron at the user's request.

## Optional accounts and project kinds

The repository includes a Better Auth slice with Hono, PostgreSQL, Drizzle migrations, Mailpit
email verification, conditional Google OAuth, and Better Auth's Electron PKCE integration. Local
development uses a loopback-only callback because macOS custom protocols require a packaged app;
packaged builds retain the declared custom-protocol callback.
The renderer exposes only account snapshots and sign-in/sign-out intents; OS-backed Electron
`safeStorage` encrypts persisted cookies. The desktop is not account-gated: local projects and local
agents work while signed out, and their recent-project state is shared by users of the Mac. Cloud
projects form a separate immutable kind and request sign-in only at cloud create/open boundaries. A
cached account identity allows its cloud projects to reopen offline; cloud recents and resumable
transfers remain isolated by account. PostgreSQL stores the account-owned cloud project catalog and
media control plane, while every project's canonical editing files remain local. Interactive
browser, email, and custom-protocol behavior still requires the requested user-run Electron test.

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

Generated local state is under ignored `.video/{cache,originals,proxies,thumbnails,waveforms,filmstrips,frames,runtime}`.
`originals/` contains explicit disposable downloads, temporary staging copies for cloud uploads,
and durable copies of macOS temporary picker exports used by local projects. Ordinary imported
source paths are referenced in place and are never moved or deleted. Cloud finalization removes
only a verified Cinesim-owned staging path. Project creation writes this layout and a project-level
`.gitignore`. Canonical saves validate and split state, pretty-print deterministically, write
temporary files, and atomically rename them.

## Command and history architecture

The only edit semantics are core commands: asset import and cascading removal; timeline creation from ordered assets and safe removal; track add, update, remove, and reorder; and clip add, remove, move, trim start/end, and split. Protocol validates inputs and delegates to core. Desktop, CLI, and MCP use that dispatcher. Stable IDs are deterministically allocated from existing IDs. The desktop keeps immutable snapshots per committed operation for undo/redo; pointer movement is ephemeral and a completed gesture commits one command.

## Media and playback architecture

Main-process metadata reads use Mediabunny `Input` + `FilePathSource`. Renderer decode uses `Input` + `UrlSource` + `VideoSampleSink` through an asset-ID custom protocol supporting bounded byte ranges. The renderer never receives raw paths or unrestricted filesystem APIs.

The monotonic playback clock resolves active timeline layers and source timestamps. Normal forward playback advances on sequence-frame boundaries with one bounded sequential Mediabunny cursor per active source and at most one playback frame in flight. Reverse and explicit seek/preview requests use safe random access through a latest-only executor. Obsolete frames are closed before compositor submission. The preview coordinator keeps timeline transport separate from temporary asset-source preview and restores the timeline frame after hover. Upcoming clips within the prewarm window call `prepare()` before a cut.

The WebGPU compositor imports each `VideoFrame` with `GPUDevice.importExternalTexture`, applies WGSL position/scale/opacity plus contain/cover/fill aspect fitting, supports ordered layers, and submits directly to a `GPUCanvasContext`. It resizes explicitly and reinitializes after device loss. CPU submission duration is reported honestly; GPU execution duration remains unavailable until timestamp queries are implemented.

A dedicated renderer worker uses Mediabunny sparse canvas sinks to generate deterministic representative JPEG thumbnails and bounded 32-tile filmstrip contact sheets. Audio-only and embedded video audio are sequentially reduced into compact, deterministic, versioned waveform peak envelopes under `.video/waveforms/`. A project-scoped main-process store fingerprints bounded source edges, atomically publishes artifacts, recovers interrupted jobs, serves validated derived-media protocol routes, accounts for storage, and evicts proxies/filmstrips/waveforms before thumbnails.

Projects choose explicit Automatic or Manual proxy generation and a named Space saver, Balanced,
High quality, or advanced Custom profile. Cloud originals always require a local proxy. The worker
creates edit representations through Mediabunny conversion and a backpressured streamed writer;
proxy conversion and perception decoding pause under foreground pressure, resume after an idle
grace period, and never block canonical edits. Valid proxies are adopted automatically.

Audio uses Mediabunny `AudioBufferSink`. A Web Audio scheduler anchors timeline microseconds to `AudioContext.currentTime`, schedules short rolling windows, stops on pause/seek, and reschedules across clip boundaries. AudioWorklet is deferred pending profiling.

## Desktop UI

Implemented surfaces include collapsible Cloud and Local project groups, inline cloud sign-in,
project create/open/forget/Trash, media import/bin, cloud upload states, keep/remove download,
explorer-style asset selection, timeline creation from ordered selected assets, cascading asset
removal, representative thumbnails, silent filmstrip card skimming, exact Media Pool source hover
preview in the WebGPU Viewer, and duration-aware asset/clip drag previews with deterministic
snapping and collision feedback. The timeline supports canonical creation/removal;
video/audio/overlay track creation, rename, mute, lock, reorder, and safe removal; adjustable track
height and zoom; selection/trim/blade tools; transient trim feedback; split/delete; filmstrip
frames; and source-range-cropped waveforms. Video assets with audio are represented exclusively as
reciprocal linked video and audio clip components on separate tracks; linked edits remain atomic and
older embedded representations are upgraded on load. The viewer distinguishes source and timeline
modes, restores the timeline frame after hover, initializes the current timeline frame even when
paused, resizes responsively, provides fit/50/100/200% display scales, configurable grids and
safe-area guides, fullscreen, exact frame stepping, and Space/J-K-L/Home/arrow transport shortcuts.
The bug control opens a dedicated Metrics sidebar that is mutually exclusive with the Agents
sidebar and reports bounded runtime, artifact, job, GPU, and storage diagnostics. Zustand stores
only ephemeral UI state; canonical project snapshots remain outside it.

The Edit workspace has persistent splitters for the Media Pool, Inspector, Notes, and Timeline. Media Pool, Inspector, and Notes visibility and final panel sizes are stored per project in the desktop's noncanonical UI state; resize movement does not write project files or create undo history.

The desktop also has independently resizable, animated left and agent sidebars whose open state and width survive reloads. The settings destination replaces the project navigation with settings sections, including an Agents page for local Claude Code and Codex discovery, login status, executable paths, models, approval modes, and the default provider.

## Local agents

Agent chats use the user's installed Claude Code or Codex executable and persist normalized transcripts outside the canonical project. Claude runs through its streaming JSON protocol; Codex runs through the `app-server` JSON-RPC protocol. Provider-specific events are normalized before they reach React, so the sidebar can render messages, reasoning, tool progress, approval requests, errors, completion, and provider-reported context-window usage consistently. The composer exposes functional per-session model and reasoning-effort controls, next-turn timeline context, and a context-remaining breakdown without estimating data a provider did not report; approval defaults remain in Agents settings.

Each provider receives a session-scoped, bearer-authenticated loopback MCP endpoint. The embedded MCP server is owned by Electron main and delegates inspection and timeline edits to the already-open `DesktopProjectStore`; it does not create a second writer or duplicate editing semantics. Supervised mode asks in the Cinesim UI before canonical edits, while auto-edit mode allows the same validated commands without the prompt. One mutating agent may run per project at a time.

Every agent turn captures canonical state before and after the turn with Git plumbing in ignored `.video/runtime/agent-checkpoints.git`. This does not require a worktree and never adds media. The UI shows the canonical diff stat and can restore the before-turn checkpoint; restoring also reloads the project and starts a fresh provider context on the next message.

## CLI and MCP

The CLI is exposed as both `cinesim` and the specification's temporary `video` alias. Inspect commands support `--json`. Clip editing accepts stable IDs and human time strings and persists through the common dispatcher.

The MCP stdio server exposes project/asset/timeline inspection, asset removal, timeline creation/removal, canonical track operations, clip add/move/trim/split/delete, and derived filmstrip/frame lookup with concise structured content. `CINESIM_PROJECT` selects the project directory for both adapters.

## Verification performed

- TypeScript whole-repository check: passed
- Vite+ format and lint check: passed with no warnings
- All 202 semantic tests in 41 files, including optional-auth project boundaries, account presentation,
  cloud transfer containment, frame-cadenced playback, overlapping seek/audio isolation,
  source-preview restoration, waveform bounds/serving/render geometry, proxy configuration, derived
  storage/writers, canonical track operations/layering, timeline interaction geometry, source
  resolution, agent integration, and shortcuts: passed
- Vite production builds for main, preload, and renderer: passed
- CLI help smoke check: passed
- Electron application launch: intentionally not run

Tests cover command semantics, project/source-kind boundaries, track compatibility/order, invalid
edits/overlaps, stable ID allocation, undo/redo, deterministic serialization and version rejection,
protocol errors, timeline-to-source mapping, monotonic timing, sequential frame scheduling,
latest-only coalescing, source-preview isolation/restoration, deterministic perception
sampling/scoring, bounded waveform encoding/writes/recovery, drag/drop and trim geometry, configured
proxy behavior, temporary import containment, cloud upload finalization, and original/proxy
resolution.

## Performance measurements

No benchmark numbers are reported. The Metrics sidebar now exposes live FPS, seek latency, request
coalescing, dropped frames, CPU GPU-submit duration, artifact jobs, and storage, but measuring
representative media still requires the interactive Electron validation matrix left to the user.

## Known limitations and deviations

- Electron/WebCodecs/WebGPU/Web Audio behavior is compiled but not interactively verified.
- Exact-frame artifact generation remains lookup-only/unimplemented; thumbnails, filmstrips, and waveforms are generated through the bounded perception worker.
- Worker-based thumbnail, filmstrip, and configured proxy paths are compiled but still require real-media Electron validation across the codec matrix.
- Audio scheduling is a V1 rolling Web Audio buffer path, not an AudioWorklet mixer.
- Audio embedded in a video clip follows that clip; linked/unlinked A/V editing is not modeled.
- The Lexical notes surface is a working draft surface but does not write `AGENTS.md` or `script.md`.
- V1 supports one active flat sequence and rejects overlaps per track; it has no transitions, nested timelines, keyframes, or export/render.
- The derived worker is emitted as a separate chunk; the renderer application chunk remains large (about 1.5 MB minified), so lazy route/vendor splitting is pending.
- The embedded agent MCP bridge shares Electron main's single project writer, but concurrent desktop and external CLI/stdio-MCP writes do not yet use a cross-process project lock or desktop file watcher.
- Local provider integration currently targets Claude Code's streaming JSON protocol and Codex's `app-server` protocol. Compatibility still depends on the installed CLI version and requires interactive desktop validation against each provider.

## Highest-value next steps

1. Run the media validation matrix, fix any platform codec/GPU findings, and capture honest playback/seek/memory metrics.
2. Tune proxy profiles from captured media-matrix measurements and add exact-frame jobs to the existing bounded worker/storage path.
3. Add cross-process project locking/file watching, then exercise desktop ↔ CLI ↔ MCP live synchronization in integration tests.
