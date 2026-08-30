import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function run(arguments_) {
  const result = spawnSync("vp", arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["run", "desktop:build"]);
run([
  "exec",
  "--filter",
  "@cinesim/desktop",
  "--",
  "electron-builder",
  "--dir",
  "--publish",
  "never",
]);
