import { spawn, spawnSync } from "node:child_process";

const children = new Set();
let shuttingDown = false;

function start(arguments_) {
  const child = spawn("pnpm", arguments_, { env: process.env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown) shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

function dockerIsReady() {
  const installed = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (installed.status !== 0) {
    console.error(
      "\nDocker is not installed. Install Docker Desktop, open it, and then run this command again.\n",
    );
    return false;
  }
  const running = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (running.status !== 0) {
    console.error(
      "\nDocker Desktop is not running. Start Docker Desktop, wait until the engine is running, and then run this command again.\n",
    );
    return false;
  }
  return true;
}

if (dockerIsReady()) {
  start(["--filter", "@cinesim/api", "dev"]);

  let apiReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8787/ready");
      if (response.ok) {
        apiReady = true;
        break;
      }
    } catch {
      // The API and database are still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  if (!apiReady) {
    console.error("\nThe local Cinesim API did not become ready. Check the output above.\n");
    shutdown(1);
  } else {
    start(["--filter", "@cinesim/desktop", "dev"]);
  }

  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  await new Promise(() => undefined);
} else {
  process.exitCode = 1;
}
