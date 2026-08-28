import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authBundle = resolve(packageDirectory, "public/auth-ui/auth.js");
const children = new Set();

function start(command, arguments_) {
  const child = spawn(command, arguments_, {
    cwd: packageDirectory,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown && code !== 0) shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

async function main() {
  const setup = start("node", ["scripts/setup-local.mjs"]);
  const setupCode = await new Promise((resolvePromise) => {
    setup.once("exit", (code) => resolvePromise(code ?? 1));
  });
  if (setupCode !== 0) {
    process.exitCode = setupCode;
    return;
  }

  start("vp", ["build", "--config", "vite.config.ts", "--watch"]);
  for (let attempt = 0; attempt < 100 && !existsSync(authBundle); attempt += 1)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  start("vp", ["exec", "--", "tsx", "watch", "src/local.ts"]);
}

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
await main();
