import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AgentProviderKind, AgentProviderSettings, AgentProviderStatus } from "../shared/api";

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
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function failureDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function detectProvider(
  provider: AgentProviderKind,
  settings: AgentProviderSettings,
): Promise<AgentProviderStatus> {
  const executablePath = await discoverProviderExecutable(provider, settings.executablePath);
  if (!executablePath) {
    return {
      provider,
      state: "not-found",
      executablePath: null,
      version: null,
      accountLabel: null,
      detail: settings.executablePath.trim()
        ? `${settings.executablePath.trim()} is not an executable file.`
        : `${PROVIDER_COMMAND[provider]} was not found on this Mac.`,
    };
  }

  let version: string;
  try {
    version = (await run(executablePath, ["--version"])).stdout;
  } catch (error) {
    return {
      provider,
      state: "error",
      executablePath,
      version: null,
      accountLabel: null,
      detail: failureDetail(error),
    };
  }

  if (provider === "claude") {
    try {
      const auth = JSON.parse((await run(executablePath, ["auth", "status", "--json"])).stdout) as {
        loggedIn?: boolean;
        email?: string;
        subscriptionType?: string;
      };
      return {
        provider,
        state: auth.loggedIn ? "connected" : "login-required",
        executablePath,
        version,
        accountLabel: auth.email ?? auth.subscriptionType ?? null,
        detail: auth.loggedIn ? null : "Claude Code is installed but is not logged in.",
      };
    } catch (error) {
      return {
        provider,
        state: "login-required",
        executablePath,
        version,
        accountLabel: null,
        detail: failureDetail(error),
      };
    }
  }

  try {
    const result = await run(executablePath, ["login", "status"]);
    const status = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = /logged in|chatgpt|api key/i.test(status) && !/not logged in/i.test(status);
    return {
      provider,
      state: loggedIn ? "connected" : "login-required",
      executablePath,
      version,
      accountLabel: loggedIn ? status.split("\n")[0] || null : null,
      detail: loggedIn ? null : status || "Codex is installed but is not logged in.",
    };
  } catch (error) {
    return {
      provider,
      state: "login-required",
      executablePath,
      version,
      accountLabel: null,
      detail: failureDetail(error),
    };
  }
}
