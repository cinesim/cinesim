#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type LogEntry = Record<string, unknown>;

const args = process.argv.slice(2);
const logDirectory = process.env.CINESIM_LOG_DIR ?? join(process.cwd(), ".context", "logs");
const limitIndex = args.indexOf("--limit");
const parsedLimit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 20;
const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;
const operationIndex = args.indexOf("--operation");
const operation = operationIndex >= 0 ? args[operationIndex + 1] : undefined;
const errorsOnly = args.includes("--errors");
const asJson = args.includes("--json");

function parseEntry(line: string): LogEntry | null {
  if (!line) return null;
  try {
    const entry = JSON.parse(line) as LogEntry;
    if (errorsOnly && typeof entry.level === "number" && entry.level < 50) return null;
    if (operation && entry.operation !== operation && entry.operationId !== operation) return null;
    return entry;
  } catch {
    return null;
  }
}

async function readLogFile(file: string): Promise<LogEntry[]> {
  const contents = await readFile(join(logDirectory, file), "utf8");
  return contents
    .split("\n")
    .map(parseEntry)
    .filter((entry): entry is LogEntry => entry !== null);
}

async function logFiles(): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(logDirectory)).filter((file) => file.endsWith(".ndjson"));
  } catch {
    return [];
  }
  return files;
}

async function readEntries(): Promise<LogEntry[]> {
  const entries = (await Promise.all((await logFiles()).map(readLogFile))).flat();
  return entries
    .toSorted((left, right) => Number(left.time ?? 0) - Number(right.time ?? 0))
    .slice(-limit);
}

const entries = await readEntries();
if (asJson) {
  process.stdout.write(`${JSON.stringify({ logDirectory, entries }, null, 2)}\n`);
} else if (entries.length === 0) {
  process.stdout.write(`No diagnostic entries in ${logDirectory}\n`);
} else {
  for (const entry of entries) {
    const time =
      typeof entry.time === "number" ? new Date(entry.time).toISOString() : "unknown-time";
    const level = typeof entry.level === "number" ? entry.level : "?";
    const service = typeof entry.service === "string" ? entry.service : "cinesim";
    const message = typeof entry.msg === "string" ? entry.msg : "";
    const operationLabel = typeof entry.operation === "string" ? ` ${entry.operation}` : "";
    process.stdout.write(`${time} level=${level} service=${service}${operationLabel} ${message}\n`);
    if (entry.err && typeof entry.err === "object")
      process.stdout.write(`  error=${JSON.stringify(entry.err)}\n`);
  }
}
