import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";

export interface CinesimLoggerOptions {
  service: string;
  directory?: string;
}

type LogEntry = Record<string, unknown>;

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
} as const;

const levelNames: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO ",
  40: "WARN ",
  50: "ERROR",
  60: "FATAL",
};

const reservedFields = new Set(["level", "time", "msg", "app", "service", "operation"]);

function terminalSafe(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isAnsiSequenceStart(value, index)) {
      index = ansiSequenceEnd(value, index);
      continue;
    }
    safe += terminalCharacter(value[index]!, code, safe.at(-1));
  }
  return safe;
}

function isAnsiSequenceStart(value: string, index: number): boolean {
  return value.charCodeAt(index) === 0x1b && value[index + 1] === "[";
}

function ansiSequenceEnd(value: string, start: number): number {
  let index = start + 2;
  while (index < value.length && !isAnsiFinalByte(value.charCodeAt(index))) index += 1;
  return index;
}

function isAnsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function terminalCharacter(character: string, code: number, previous: string | undefined): string {
  if (code === 0x0a || code === 0x0d) return previous === " " ? "" : " ";
  if (code < 0x20 || code === 0x7f) return "?";
  return character;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return terminalSafe(value);
  try {
    return terminalSafe(JSON.stringify(value) ?? String(value));
  } catch {
    return "[unserializable]";
  }
}

function colorize(value: string, color: string | undefined, colors: boolean): string {
  return colors && color ? `${color}${value}${ANSI.reset}` : value;
}

function levelColor(level: number): string {
  if (level >= 50) return ANSI.red;
  if (level >= 40) return ANSI.yellow;
  if (level >= 30) return ANSI.green;
  return ANSI.blue;
}

/** Formats one parsed log entry for humans without changing the NDJSON entry. */
export function formatTerminalLogLine(entry: LogEntry, colors = false): string {
  const time =
    typeof entry.time === "number" && Number.isFinite(entry.time)
      ? new Date(entry.time).toISOString().replace("T", " ").replace(".000Z", "Z")
      : "unknown-time";
  const level = typeof entry.level === "number" ? entry.level : 30;
  const levelName = levelNames[level] ?? `LEVEL${level}`.padEnd(6, " ").slice(0, 6);
  const service = typeof entry.service === "string" ? entry.service : "cinesim";
  const operation = typeof entry.operation === "string" ? entry.operation : undefined;
  const message = typeof entry.msg === "string" ? entry.msg : "";
  const context = Object.entries(entry)
    .filter(([key]) => !reservedFields.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");

  const headline = [
    colorize(time, ANSI.dim, colors),
    colorize(levelName, levelColor(level), colors),
    colorize(service, ANSI.cyan, colors),
    operation ? colorize(operation, ANSI.magenta, colors) : undefined,
    message ? terminalSafe(message) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("  ");

  return context ? `${headline}\n  ${colorize(context, ANSI.dim, colors)}\n` : `${headline}\n`;
}

function createTerminalStream(colors: boolean): Writable {
  let pending = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          process.stderr.write(formatTerminalLogLine(JSON.parse(line) as LogEntry, colors));
        } catch {
          process.stderr.write(`${terminalSafe(line)}\n`);
        }
      }
      callback();
    },
    final(callback) {
      if (pending) {
        try {
          process.stderr.write(formatTerminalLogLine(JSON.parse(pending) as LogEntry, colors));
        } catch {
          process.stderr.write(`${terminalSafe(pending)}\n`);
        }
      }
      callback();
    },
  });
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
    ...(process.env.VITEST
      ? []
      : [
          {
            level: "info" as const,
            stream: createTerminalStream(Boolean(process.stderr.isTTY) && !process.env.NO_COLOR),
          },
        ]),
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
