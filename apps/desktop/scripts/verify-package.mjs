import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronFuses from "@electron/fuses";

const { FuseV1Options, getCurrentFuseWire } = electronFuses;
const FUSE_DISABLED = "0".charCodeAt(0);
const FUSE_ENABLED = "1".charCodeAt(0);

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(desktopRoot, "release");

function packagedApplication() {
  if (process.argv[2]) return resolve(process.argv[2]);
  if (!existsSync(releaseRoot)) throw new Error("No desktop release directory exists");
  const matches = readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => join(releaseRoot, entry.name, "Cinesim.app"))
    .filter(existsSync);
  if (matches.length !== 1)
    throw new Error(`Expected one packaged Cinesim.app, found ${matches.length}`);
  return matches[0];
}

const application = packagedApplication();
const resources = join(application, "Contents", "Resources");
const binary = join(application, "Contents", "MacOS", "Cinesim");
for (const requiredPath of [application, binary, join(resources, "app.asar")]) {
  if (!existsSync(requiredPath)) throw new Error(`Missing packaged artifact: ${requiredPath}`);
}
if (existsSync(join(resources, "app")))
  throw new Error("Packaged application contains an unpacked app directory");

const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FUSE_DISABLED],
  [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FUSE_DISABLED],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_DISABLED],
]);
const fuseWire = await getCurrentFuseWire(binary);
for (const [fuse, expected] of expectedFuses) {
  if (fuseWire[fuse] !== expected)
    throw new Error(`Packaged Electron fuse ${FuseV1Options[fuse]} has an unsafe state`);
}

console.log(`Verified packaged security policy: ${application}`);
