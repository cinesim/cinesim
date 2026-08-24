# Technical decisions

## Toolchain and Electron build

Cinesim uses pnpm workspaces for dependency resolution and Vite+ 0.2 for repository-wide formatting, linting, testing, task execution, and caching. There is one root `vite.config.ts`; the desktop package adds one mode-aware config because Electron has three genuinely different targets: Node-flavored main, sandbox-compatible preload, and browser renderer.

We do not use `electron-vite`. Current Electron builds are straightforward Vite library builds, while coupling another wrapper to Vite+'s fast-moving Vite version would duplicate configuration and reduce transparency. `vp run desktop:build` invokes the same Vite implementation for all three targets. The small development launcher only coordinates watch processes; it is not another bundler.

## Project state

`cinesim.json` is the stable project entry point. Complex canonical collections live in deterministic JSON under `.cinesim/`; human-edited preferences live in `.cinesim/settings.toml`. The generated `.video/` tree contains only caches, proxies, perception artifacts, and runtime scratch data and is ignored as a unit.

Core uses integer microseconds. IDs are stable, prefixed strings. Unordered collections are sorted before serialization, while sequence track arrays preserve authored layer order. Unknown schema versions are rejected. Disk adapters use temp-file-plus-rename atomic replacement; core itself has no filesystem dependency.

Undo/redo stores immutable project snapshots per committed command. This is the simplest correct V1 behavior and naturally makes a completed drag one undo step while ephemeral pointer previews remain UI-only.

## Command pathway

React, CLI, and MCP submit the same Zod-validated protocol commands. Protocol dispatch delegates to the single deterministic implementation in `@cinesim/core`. Only Electron main or a Node adapter persists returned canonical state.

## Media access and playback

Mediabunny 1.55 is used, unmodified, as an MPL-2.0 runtime dependency. Main-process metadata inspection uses `FilePathSource`, which performs lazy random access. Renderer playback uses `UrlSource` against an asset-ID-only custom Electron protocol with byte-range responses; raw paths are never exposed by preload.

`VideoSampleSink` supplies decoded samples backed by WebCodecs. The runtime maps monotonic clock time to sequence-frame timestamps and resolves active clips. Forward transport uses bounded sequential cursors and admits one playback frame operation at a time, preventing display-refresh callbacks from repeatedly obsoleting slow decodes. Reverse playback and explicit seek/preview requests retain latest-only random access. Side effects are generation-gated and obsolete `VideoFrame` objects close before composition. Temporary asset preview is separate from timeline transport, and React receives throttled snapshots and intents rather than frame objects.

Audio uses Mediabunny's `AudioBufferSink` and Web Audio scheduling. V1 treats `AudioContext.currentTime` as the audio scheduling reference when audio is active, but transport time still comes from the replaceable clock abstraction. An AudioWorklet is intentionally deferred until profiling demonstrates that buffered main-thread scheduling is insufficient.

## Composition

The preview compositor is WebGPU-first. `GPUDevice.importExternalTexture({ source: videoFrame })` feeds a WGSL pipeline without CPU pixel readback. Transform and opacity are uniforms; pipeline structure accepts multiple layers even though V1 commonly resolves one visible video clip per track. Frames are closed after submission, canvas resize is explicit, and device loss triggers reinitialization.

Canvas2D is limited to filmstrip/thumbnail generation, where a CPU-readable image artifact is the desired output.

## Workers and proxies

Decode-heavy derived work runs in one dedicated renderer worker. Sparse Mediabunny canvas sinks and OffscreenCanvas create bounded thumbnails and filmstrip contact sheets. Sequential Mediabunny audio buffers are reduced to a deterministic mono min/max envelope with at most 4,096 peaks; the versioned little-endian `CSWF` artifact is at most 16,400 bytes and retains no decoded audio. The same worker uses Mediabunny conversion for video-only editing proxies, selecting a supported MP4 codec at runtime and streaming bounded chunks with renderer-to-main acknowledgements so encoder backpressure reaches the filesystem writer. Foreground playback, seeks, hover preview, and timeline dragging defer new derived jobs and pause active decode/conversion work between bounded units; idle grace resumes it.

Derived state is disposable and noncanonical under `.video/`. Main owns source fingerprints, validated contained paths, atomic writer sessions, artifact serving, storage budgets, recovery, and eviction. Waveform writers must declare the exact duration-derived byte bound, and publication validates the format version, peak count, and final size. A pure closed-loop policy chooses the original or queues a proxy from observed warmed-seek latency, deadline misses, and request coalescing. Valid proxies have hysteresis and are selected automatically; failures fall back to the original. No FFmpeg-backed Mediabunny codec extension is included, so footage Chromium cannot decode cannot be proxied by this path.

## Security

The renderer has no Node access. `contextIsolation`, renderer sandboxing, web security, permission denial, navigation blocking, and a strict Content Security Policy are enabled. Preload exposes individual validated calls instead of `ipcRenderer`. Media access is restricted to asset IDs already present in the open project.

## Local agent orchestration

Cinesim treats Claude Code and Codex as local provider runtimes rather than reimplementing an agent loop. Claude is driven with newline-delimited streaming JSON and Codex with the `app-server` JSON-RPC protocol. A small normalization layer converts both into one persistent UI event model. Provider session IDs are retained for normal continuation, while reverting a checkpoint intentionally clears provider context so conversation state cannot silently disagree with restored project state.

Providers do not receive direct canonical write access. They connect to a bearer-authenticated MCP endpoint bound to loopback, scoped to one agent session and one open project. Electron main owns that endpoint and submits all mutations to `DesktopProjectStore`, preserving the same protocol validation, command history, renderer notifications, and single-writer boundary as manual edits. Claude's native tools are restricted to project reads and the Cinesim MCP namespace; Codex runs read-only and performs edits through that namespace.

Agent checkpoints borrow T3 Code's Git-object approach without creating worktrees. A temporary index snapshots only `cinesim.json` and `.cinesim/` into hidden refs in an ignored bare repository under `.video/runtime/`. Media remains referenced in place and is never copied into checkpoints. This makes turn diffs and restoration cheap, local, inspectable, and independent of the user's branch or working-tree index.

## Research basis

Decisions were checked against current stable documentation for Vite+, Electron security and custom protocols, React 19/Compiler, Mediabunny sources and sinks, the browser WebCodecs/WebGPU APIs, Web Audio, and the official MCP TypeScript SDK. Open-source editor structures (including FreeCut) and agent orchestrators (including T3 Code) were used as comparison points only; no third-party source was copied.

Primary references:

- [Vite+ configuration](https://viteplus.dev/config/) and [workspace task runner](https://viteplus.dev/guide/run)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) and [custom protocols](https://www.electronjs.org/docs/latest/api/protocol)
- [Mediabunny file sources](https://mediabunny.dev/guide/reading-media-files) and [decoded media sinks](https://mediabunny.dev/guide/media-sinks)
- [WebCodecs rendering and resource lifetime](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API)
- [React Compiler](https://react.dev/learn/react-compiler/introduction)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
