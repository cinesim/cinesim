import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectOpenTarget, ProjectOpenTargetId } from "../../shared/contracts";

interface ApplicationTarget extends ProjectOpenTarget {
  applicationName: string;
  paths: readonly string[];
}

type PathAccess = (path: string) => Promise<void>;
type ApplicationLaunch = (arguments_: readonly string[]) => Promise<void>;

const executeFile = promisify(execFile);
const userApplications = join(homedir(), "Applications");

export const FINDER_TARGET: ProjectOpenTarget = {
  id: "finder",
  label: "Finder",
  kind: "file-manager",
};

const APPLICATION_TARGETS: readonly ApplicationTarget[] = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    kind: "editor",
    applicationName: "Visual Studio Code",
    paths: [
      "/Applications/Visual Studio Code.app",
      join(userApplications, "Visual Studio Code.app"),
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    applicationName: "Cursor",
    paths: ["/Applications/Cursor.app", join(userApplications, "Cursor.app")],
  },
  {
    id: "zed",
    label: "Zed",
    kind: "editor",
    applicationName: "Zed",
    paths: ["/Applications/Zed.app", join(userApplications, "Zed.app")],
  },
  {
    id: "ghostty",
    label: "Ghostty",
    kind: "terminal",
    applicationName: "Ghostty",
    paths: ["/Applications/Ghostty.app", join(userApplications, "Ghostty.app")],
  },
  {
    id: "terminal",
    label: "Terminal",
    kind: "terminal",
    applicationName: "Terminal",
    paths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
  },
];

async function pathExists(path: string, pathAccess: PathAccess): Promise<boolean> {
  try {
    await pathAccess(path);
    return true;
  } catch {
    return false;
  }
}

async function targetInstalled(
  target: ApplicationTarget,
  pathAccess: PathAccess,
): Promise<boolean> {
  const results = await Promise.all(target.paths.map((path) => pathExists(path, pathAccess)));
  return results.some(Boolean);
}

export async function availableProjectOpenTargets(
  pathAccess: PathAccess = access,
): Promise<ProjectOpenTarget[]> {
  const installed = await Promise.all(
    APPLICATION_TARGETS.map(async (target) => ({
      target,
      installed: await targetInstalled(target, pathAccess),
    })),
  );
  return [
    FINDER_TARGET,
    ...installed
      .filter((candidate) => candidate.installed)
      .map(({ target: { applicationName: _applicationName, paths: _paths, ...target } }) => target),
  ];
}

async function launchMacApplication(arguments_: readonly string[]): Promise<void> {
  await executeFile("/usr/bin/open", [...arguments_]);
}

function openArguments(target: ApplicationTarget, directory: string): string[] {
  if (target.id === "ghostty")
    return ["-na", target.applicationName, "--args", `--working-directory=${directory}`];
  return ["-a", target.applicationName, directory];
}

export async function launchProjectOpenTarget(
  targetId: Exclude<ProjectOpenTargetId, "finder">,
  directory: string,
  launch: ApplicationLaunch = launchMacApplication,
): Promise<void> {
  const target = APPLICATION_TARGETS.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`Unsupported project open target: ${targetId}`);
  await launch(openArguments(target, directory));
}
