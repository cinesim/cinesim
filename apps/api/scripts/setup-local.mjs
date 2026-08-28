import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillMissingEnvironmentVariables, populateAuthSecret } from "./environment-file.mjs";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const environmentPath = resolve(packageDirectory, ".env.local");
const examplePath = resolve(packageDirectory, ".env.example");
const composePath = resolve(workspaceDirectory, "compose.yaml");

class LocalSetupError extends Error {}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? workspaceDirectory,
      env: process.env,
      stdio: options.quiet ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureEnvironment() {
  const example = await readFile(examplePath, "utf8");
  const secret = randomBytes(32).toString("base64url");

  if (existsSync(environmentPath)) {
    const existing = await readFile(environmentPath, "utf8");
    const backfilled = backfillMissingEnvironmentVariables(existing, example, secret);
    if (backfilled.addedKeys.length === 0) return;

    await writeFile(environmentPath, backfilled.contents, { mode: 0o600 });
    console.log(
      `Updated apps/api/.env.local with missing settings: ${backfilled.addedKeys.join(", ")}`,
    );
    return;
  }

  await writeFile(environmentPath, populateAuthSecret(example, secret), { mode: 0o600 });
  console.log("Created apps/api/.env.local with a random local-only auth secret.");
}

async function ensureDocker() {
  try {
    await run("docker", ["--version"], { quiet: true });
  } catch {
    throw new LocalSetupError(
      "Docker is not installed. Install Docker Desktop, open it, and then run this command again.",
    );
  }

  try {
    await run("docker", ["info"], { quiet: true });
  } catch {
    throw new LocalSetupError(
      "Docker Desktop is not running. Start Docker Desktop, wait until the engine is running, and then run this command again.",
    );
  }
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await run(
        "docker",
        [
          "compose",
          "-f",
          composePath,
          "exec",
          "-T",
          "postgres",
          "pg_isready",
          "-U",
          "cinesim",
          "-d",
          "cinesim",
        ],
        { quiet: true },
      );
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new Error("Local PostgreSQL did not become ready within 30 seconds");
}

async function main() {
  await ensureEnvironment();
  await ensureDocker();
  await run("docker", ["compose", "-f", composePath, "up", "-d", "postgres", "mailpit"]);
  await waitForPostgres();
  await run("vp", ["run", "db:migrate"], { cwd: packageDirectory });
  console.log("Local authentication services are ready.");
  console.log("Mailpit inbox: http://127.0.0.1:8025");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Local authentication setup failed";
  console.error(
    `\n${error instanceof LocalSetupError ? message : `Local setup failed: ${message}`}\n`,
  );
  process.exitCode = 1;
}
