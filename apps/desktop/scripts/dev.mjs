import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = Number(
  process.env.CONDUCTOR_PORT ||
    new URL(process.env.CINESIM_DEV_SERVER_URL || "http://127.0.0.1:5173").port ||
    5173,
);
const url = `http://127.0.0.1:${port}`;
const logDirectory = fileURLToPath(new URL("../../../.context/logs/", import.meta.url));
const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env, ...options });
  children.push(child);
  child.on("exit", (code) => {
    if (code && !stopping) shutdown(code);
  });
  return child;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("vp", ["build", "apps/desktop", "--mode", "main", "--watch"]);
run("vp", ["build", "apps/desktop", "--mode", "preload", "--watch"]);
run("vp", ["dev", "apps/desktop", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]);

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch(url);
    if (response.ok) break;
  } catch {
    // The dev server is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

while (true) {
  try {
    await Promise.all([
      import("node:fs/promises").then((fs) =>
        fs.access(new URL("../dist/main/main.js", import.meta.url)),
      ),
      import("node:fs/promises").then((fs) =>
        fs.access(new URL("../dist/preload/preload.cjs", import.meta.url)),
      ),
    ]);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

run("vp", ["exec", "--filter", "@cinesim/desktop", "--", "electron", "."], {
  env: { ...process.env, CINESIM_DEV_SERVER_URL: url, CINESIM_LOG_DIR: logDirectory },
});
