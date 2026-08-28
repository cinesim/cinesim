# Cinesim

Cinesim is an MIT-licensed, local-first nonlinear video editor designed so people and coding agents edit the same deterministic project model. The desktop application uses Electron and React; media playback is timeline-driven through Mediabunny, WebCodecs, Web Audio, and a WebGPU compositor.

## Development

Requirements: Node.js 22.12 or newer and the global [Vite+ `vp` command](https://viteplus.dev/guide/). Vite+ installs and runs the Bun version pinned by the repository; Bun is the package manager, while Cinesim continues to run on Node.js.

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
vp run api:setup
vp run local:dev
```

The setup creates an ignored local secret, starts PostgreSQL and Mailpit, and applies committed auth
migrations. See [local authentication](docs/internals/authentication.mdx) for email verification, Google OAuth,
service addresses, and the production mapping.

`vp install` also installs the repository's Vite+ pre-commit hook. The hook runs formatting,
linting, and type-aware checks against staged files and applies safe fixes before the commit.

The development command builds and watches Electron main/preload code, starts the renderer server, then launches Electron. In Conductor, the configured run action supplies a workspace-specific port.

Static workflows do not launch Electron:

```bash
vp run verify:fast # formatting, linting, types, and tests
vp run build:all   # desktop, API browser bundle, and Next.js site
vp run verify      # the complete CI gate
```

GitHub CI runs the complete verification gate for pull requests and pushes to `main`.

Run the agent-facing adapters from the repository root, pointing them at a Cinesim project when it
is elsewhere:

```bash
vp run cli --project ~/films/documentary-cut project inspect --json
vp run cli --project ~/films/documentary-cut timeline inspect --json
vp run cli --project ~/films/documentary-cut clip split clip_123 --at 4.2s
CINESIM_PROJECT=~/films/documentary-cut vp run mcp
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

Local projects work without an account and reference ordinary source media in place. Temporary
Apple Photos picker exports receive a managed copy under `.video/originals/` so they do not vanish.
Cloud projects require sign-in and automatically store supported originals privately after a local
edit proxy is ready. Users can explicitly keep or remove a disposable downloaded original under
`.video/originals/`; external source files are never moved or deleted.

See [architecture](docs/internals/architecture.mdx), [project format](docs/reference/project-files.mdx),
[cloud originals](docs/internals/cloud-storage.mdx), and [dependency licenses](docs/internals/dependencies.mdx).

[Project status](docs/internals/status.mdx) records what is built, what still needs interactive verification, known limitations, and the next engineering steps.
