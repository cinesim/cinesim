# Dependency licenses

The repository's own source is MIT. Versions are pinned in package manifests and the lockfile is authoritative.

Runtime dependencies:

| Dependency                          | Purpose                              | License      |
| ----------------------------------- | ------------------------------------ | ------------ |
| Fontsource Geist Variable           | Bundled cross-platform UI typeface   | OFL-1.1      |
| React / React DOM                   | Renderer UI                          | MIT          |
| react-markdown                      | Safe agent-response Markdown         | MIT          |
| Tailwind CSS / Tailwind Vite plugin | Styling                              | MIT          |
| Base UI                             | Accessible headless primitives       | MIT          |
| class-variance-authority            | Component variants                   | Apache-2.0   |
| tailwind-merge                      | Tailwind class composition           | MIT          |
| Hugeicons Free / React              | Free icon data and React renderer    | MIT          |
| Lucide React                        | Timeline transport controls          | ISC          |
| dnd-kit                             | Timeline drag/drop                   | MIT          |
| Zustand                             | Ephemeral renderer state             | MIT          |
| TanStack Router                     | Renderer routing                     | MIT          |
| Lexical                             | Notes/editor surfaces                | MIT          |
| Zod                                 | Protocol and file validation         | MIT          |
| Mediabunny                          | Container access and WebCodecs sinks | MPL-2.0      |
| smol-toml                           | Human-readable settings parsing      | BSD-3-Clause |
| Commander                           | CLI parsing                          | MIT          |
| MCP TypeScript SDK                  | MCP adapters and local agent bridge  | MIT          |
| Pino                                | Structured local diagnostics         | MIT          |
| Better Auth / Electron integration  | Server and desktop authentication    | MIT          |
| Hono / Hono Node server             | HTTP API and local server adapter    | MIT          |
| Drizzle ORM                         | Typed PostgreSQL queries             | Apache-2.0   |
| node-postgres (`pg`)                | PostgreSQL connection pooling        | MIT          |
| Nodemailer                          | Verification email over SMTP         | MIT-0        |
| aws4fetch                           | AWS Signature V4 for private R2 I/O  | MIT          |

Development services:

| Service                    | Purpose                           | License            |
| -------------------------- | --------------------------------- | ------------------ |
| PostgreSQL 17 Docker image | Local authentication database     | PostgreSQL License |
| Mailpit                    | Local SMTP server and email inbox | MIT                |

Build-only dependencies (Vite+, Vite, TypeScript, React Compiler, Electron, electron-builder, tsx, type packages) use MIT, Apache-2.0, or BSD-style licenses. Cinesim does not copy or modify Mediabunny source and does not include optional FFmpeg/libavcodec-backed codec extensions.
