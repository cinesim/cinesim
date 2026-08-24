import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";

export interface CinesimLoggerOptions {
  service: string;
  directory?: string;
}

export function createCinesimLogger(options: CinesimLoggerOptions): Logger {
  const directory =
    options.directory ?? process.env.CINESIM_LOG_DIR ?? join(process.cwd(), ".context", "logs");
  mkdirSync(directory, { recursive: true });

  const file = pino.destination({
    dest: join(directory, `${options.service}.ndjson`),
    sync: true,
  });
  const streams = [
    { level: "debug" as const, stream: file },
    ...(process.env.VITEST ? [] : [{ level: "info" as const, stream: process.stderr }]),
  ];

  return pino(
    {
      level: process.env.CINESIM_LOG_LEVEL ?? "info",
      base: { app: "cinesim", service: options.service },
      redact: ["authorization", "credentials", "password", "token", "mcpToken", "mcp_token"],
    },
    pino.multistream(streams),
  );
}
