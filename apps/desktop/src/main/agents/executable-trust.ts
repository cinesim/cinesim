import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

export interface AgentExecutableIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  modifiedMs: number;
}

export async function inspectAgentExecutable(path: string): Promise<AgentExecutableIdentity> {
  const canonicalPath = await realpath(path);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) throw new Error("The selected agent executable is not a regular file");
  await access(canonicalPath, constants.X_OK);
  return {
    path: canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
  };
}

export async function verifyAgentExecutable(expected: AgentExecutableIdentity): Promise<string> {
  const actual = await inspectAgentExecutable(expected.path);
  if (
    actual.path !== expected.path ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.size !== expected.size ||
    actual.modifiedMs !== expected.modifiedMs
  ) {
    throw new Error("The configured agent executable changed; choose or detect it again");
  }
  return actual.path;
}

export function isAgentExecutableIdentity(value: unknown): value is AgentExecutableIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentExecutableIdentity>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.device === "number" &&
    Number.isSafeInteger(candidate.device) &&
    typeof candidate.inode === "number" &&
    Number.isSafeInteger(candidate.inode) &&
    typeof candidate.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    typeof candidate.modifiedMs === "number" &&
    Number.isFinite(candidate.modifiedMs)
  );
}
