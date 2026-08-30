import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentProviderKind,
  AgentProviderSettings,
  AgentProviderStatus,
} from "../../shared/contracts";
import {
  PROVIDER_DETECTION_MAX_OUTPUT_BYTES,
  PROVIDER_DETECTION_TIMEOUT_MS,
} from "./runtime-policy";

const execFileAsync = promisify(execFile);
const PROVIDER_COMMAND: Record<AgentProviderKind, string> = { claude: "claude", codex: "codex" };

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverProviderExecutable(
  provider: AgentProviderKind,
  configuredPath = "",
): Promise<string | null> {
  if (configuredPath.trim())
    return (await executableExists(configuredPath.trim())) ? configuredPath.trim() : null;
  const command = PROVIDER_COMMAND[provider];
  const searchDirectories = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean) as string[]),
  ];
  for (const directory of new Set(searchDirectories)) {
    const candidate = join(directory, command);
    if (await executableExists(candidate)) return candidate;
  }
  return null;
}

async function run(
  executablePath: string,
  arguments_: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executablePath, arguments_, {
    timeout: PROVIDER_DETECTION_TIMEOUT_MS,
    maxBuffer: PROVIDER_DETECTION_MAX_OUTPUT_BYTES,
    env: process.env,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function failureDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function status(
  provider: AgentProviderKind,
  state: AgentProviderStatus["state"],
  executablePath: string | null,
  version: string | null,
  detail: string | null,
  accountLabel: string | null = null,
): AgentProviderStatus {
  return { provider, state, executablePath, version, accountLabel, detail };
}

async function detectVersion(
  provider: AgentProviderKind,
  executablePath: string,
): Promise<AgentProviderStatus | string> {
  try {
    return (await run(executablePath, ["--version"])).stdout;
  } catch (error) {
    return status(provider, "error", executablePath, null, failureDetail(error));
  }
}

async function detectClaude(executablePath: string, version: string): Promise<AgentProviderStatus> {
  try {
    const auth = JSON.parse((await run(executablePath, ["auth", "status", "--json"])).stdout) as {
      loggedIn?: boolean;
      email?: string;
      subscriptionType?: string;
    };
    return status(
      "claude",
      auth.loggedIn ? "connected" : "login-required",
      executablePath,
      version,
      auth.loggedIn ? null : "Claude Code is installed but is not logged in.",
      auth.email ?? auth.subscriptionType ?? null,
    );
  } catch (error) {
    return status("claude", "login-required", executablePath, version, failureDetail(error));
  }
}

async function detectCodex(executablePath: string, version: string): Promise<AgentProviderStatus> {
  try {
    const result = await run(executablePath, ["login", "status"]);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = /logged in|chatgpt|api key/i.test(output) && !/not logged in/i.test(output);
    return status(
      "codex",
      loggedIn ? "connected" : "login-required",
      executablePath,
      version,
      loggedIn ? null : output || "Codex is installed but is not logged in.",
      loggedIn ? output.split("\n")[0] || null : null,
    );
  } catch (error) {
    return status("codex", "login-required", executablePath, version, failureDetail(error));
  }
}

export async function detectProvider(
  provider: AgentProviderKind,
  settings: AgentProviderSettings,
): Promise<AgentProviderStatus> {
  const executablePath = await discoverProviderExecutable(provider, settings.executablePath);
  if (!executablePath) {
    const detail = settings.executablePath.trim()
      ? `${settings.executablePath.trim()} is not an executable file.`
      : `${PROVIDER_COMMAND[provider]} was not found on this Mac.`;
    return status(provider, "not-found", null, null, detail);
  }

  const version = await detectVersion(provider, executablePath);
  if (typeof version !== "string") return version;
  return provider === "claude"
    ? detectClaude(executablePath, version)
    : detectCodex(executablePath, version);
}
