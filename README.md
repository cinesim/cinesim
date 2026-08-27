# Cinesim

Cinesim is an MIT-licensed, local-first nonlinear video editor designed so people and coding agents edit the same deterministic project model. The desktop application uses Electron and React; media playback is timeline-driven through Mediabunny, WebCodecs, Web Audio, and a WebGPU compositor.

## Development

Requirements: Node.js 22.12 or newer and the global [Vite+ `vp` command](https://viteplus.dev/guide/). Vite+ installs and runs the pnpm version pinned by the repository.

Install Vite+ once on macOS or Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Then install dependencies and start Cinesim:

```bash
vp install
vp run desktop:dev
```

The ordinary desktop command remains local-only and does not require an account. To develop the
optional account flow, install Docker Desktop and run:

```bash
pnpm auth:setup
pnpm dev:local
```

The setup creates an ignored local secret, starts PostgreSQL and Mailpit, and applies committed auth
migrations. See [local authentication](docs/authentication.md) for email verification, Google OAuth,
service addresses, and the production mapping.

`vp install` also installs the repository's Vite+ pre-commit hook. The hook runs formatting,
linting, and type-aware checks against staged files and applies safe fixes before the commit.

The development command builds and watches Electron main/preload code, starts the renderer server, then launches Electron. In Conductor, the configured run action supplies a workspace-specific port.

Static workflows do not launch Electron:

```bash
vp check
vp test --run
vp run desktop:build
```

GitHub CI runs those static checks, the TypeScript compiler, the test suite, and all desktop
bundles for pull requests and pushes to `main`.

Run the agent-facing adapters from a Cinesim project directory:

```bash
vp run cli project inspect --json
vp run cli timeline inspect --json
vp run cli clip split clip_123 --at 4.2s
vp run mcp
```

## Project format

Projects are ordinary directories. Canonical state is Git-friendly and generated media is disposable:

```text
my-project/
├── cinesim.json
├── AGENTS.md
├── script.md                 # optional user content
├── research/                 # optional user content
├── .cinesim/
│   ├── assets.json
│   ├── timeline.json
│   └── settings.toml
└── .video/                   # ignored, generated/local only
    ├── cache/
    ├── originals/
    ├── proxies/
    ├── thumbnails/
    ├── waveforms/
    ├── filmstrips/
    ├── frames/
    └── runtime/
```

Local source media is referenced in place and is never moved or deleted by cloud upload. Supported
originals are automatically stored privately after a local edit proxy is ready. Users can
explicitly keep a disposable copy under `.video/originals/`; deleting `.video/` remains safe and
cloud-backed originals and proxies can be downloaded or regenerated while online.

See [technical decisions](docs/technical-decisions.md), [project format](docs/project-format.md),
[cloud originals](docs/cloud-storage.md), and [dependency licenses](docs/dependencies.md).

The detailed [V1 implementation status](docs/implementation-status.md) records exactly what is implemented, what was verified without launching Electron, known limitations, and the next engineering steps.
