# Dependency licenses

The repository's own source is MIT. Versions are pinned in package manifests and the lockfile is authoritative.

Runtime dependencies:

| Dependency                          | Purpose                              | License      |
| ----------------------------------- | ------------------------------------ | ------------ |
| React / React DOM                   | Renderer UI                          | MIT          |
| Tailwind CSS / Tailwind Vite plugin | Styling                              | MIT          |
| Base UI                             | Accessible headless primitives       | MIT          |
| class-variance-authority            | Component variants                   | Apache-2.0   |
| tailwind-merge                      | Tailwind class composition           | MIT          |
| Lucide React                        | Icons                                | ISC          |
| dnd-kit                             | Timeline drag/drop                   | MIT          |
| Zustand                             | Ephemeral renderer state             | MIT          |
| TanStack Router                     | Renderer routing                     | MIT          |
| Lexical                             | Notes/editor surfaces                | MIT          |
| Zod                                 | Protocol and file validation         | MIT          |
| Mediabunny                          | Container access and WebCodecs sinks | MPL-2.0      |
| smol-toml                           | Human-readable settings parsing      | BSD-3-Clause |
| Commander                           | CLI parsing                          | MIT          |
| MCP TypeScript SDK                  | MCP stdio adapter                    | MIT          |

Build-only dependencies (Vite+, Vite, TypeScript, React Compiler, Electron, electron-builder, tsx, type packages) use MIT, Apache-2.0, or BSD-style licenses. Cinesim does not copy or modify Mediabunny source and does not include optional FFmpeg/libavcodec-backed codec extensions.
