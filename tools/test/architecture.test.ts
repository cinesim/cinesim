import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const workspaceRoot = process.cwd();

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface NamedPackageManifest extends PackageManifest {
  name: string;
}

async function filesBelow(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesBelow(path, extension);
      return entry.isFile() && path.endsWith(extension) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("architecture boundaries", () => {
  it("keeps forbidden platform dependencies out of core", async () => {
    const sourceRoot = join(workspaceRoot, "packages/core/src");
    const files = await filesBelow(sourceRoot, ".ts");
    const forbiddenSpecifier =
      /(?:from\s+|import\s*\()["'](?:electron|react(?:\/|["'])|mediabunny|@modelcontextprotocol|node:(?:fs|path|os)|@cinesim\/(?:engine|mcp-tools|project-io)|\.\.\/\.\.\/(?:apps|tools)\/)/u;
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (forbiddenSpecifier.test(source)) violations.push(relative(workspaceRoot, file));
    }

    expect(violations).toEqual([]);
  });

  it("keeps both MCP adapters on the canonical tool catalog", async () => {
    const adapters = ["apps/desktop/src/main/agents/mcp/server.ts", "tools/mcp/src/index.ts"];

    for (const adapter of adapters) {
      const source = await readFile(join(workspaceRoot, adapter), "utf8");
      expect(source).toContain("registerCinesimMcpTools");
      expect(source).not.toMatch(/\.registerTool\s*\(/u);
    }
  });

  it("requires privileged IPC handlers to use the sender-validating wrapper", async () => {
    const mainRoot = join(workspaceRoot, "apps/desktop/src/main");
    const files = await filesBelow(mainRoot, ".ts");
    const directRegistrations: string[] = [];

    for (const file of files) {
      if (file.endsWith("/app/secure-ipc.ts")) continue;
      const source = await readFile(file, "utf8");
      if (/ipcMain\.handle\s*\(/u.test(source)) {
        directRegistrations.push(relative(workspaceRoot, file));
      }
    }

    expect(directRegistrations).toEqual([]);
  });

  it("keeps the workspace package dependency graph acyclic", async () => {
    const packageRoots = ["apps", "packages", "tools"];
    const manifests = (
      await Promise.all(
        packageRoots.map(async (root) => {
          const entries = await readdir(join(workspaceRoot, root), { withFileTypes: true });
          return Promise.all(
            entries
              .filter((entry) => entry.isDirectory())
              .map(async (entry) => {
                const manifestPath = join(workspaceRoot, root, entry.name, "package.json");
                try {
                  return JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
                } catch {
                  return undefined;
                }
              }),
          );
        }),
      )
    )
      .flat()
      .filter(
        (manifest): manifest is NamedPackageManifest =>
          manifest !== undefined && manifest.name !== undefined,
      );
    const packageNames = new Set(manifests.map((manifest) => manifest.name));
    const graph = new Map(
      manifests.map((manifest) => [
        manifest.name,
        Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) =>
          packageNames.has(name),
        ),
      ]),
    );
    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = (name: string, path: string[]): void => {
      if (active.has(name))
        throw new Error(`Workspace dependency cycle: ${[...path, name].join(" -> ")}`);
      if (visited.has(name)) return;
      active.add(name);
      for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
      active.delete(name);
      visited.add(name);
    };

    for (const name of graph.keys()) visit(name, []);
    expect(visited).toEqual(packageNames);
  });

  it("keeps desktop hubs as coordinators over focused collaborators", async () => {
    const rendererStore = await readFile(
      join(workspaceRoot, "apps/desktop/src/renderer/store/renderer-store.ts"),
      "utf8",
    );
    for (const factory of [
      "createProjectSlice",
      "createEditorInteractionSlice",
      "createPlaybackMediaSlice",
      "createAccountCloudSlice",
    ])
      expect(rendererStore).toContain(factory);
    expect(rendererStore).not.toContain("api.");

    const timeline = await readFile(
      join(workspaceRoot, "apps/desktop/src/renderer/components/timeline/timeline.tsx"),
      "utf8",
    );
    expect(timeline).toContain('from "./timeline-track"');
    expect(timeline).toContain('from "./reduced-timeline"');
    expect(timeline).not.toContain("function ClipBlock");
    expect(timeline).not.toContain("function TimelineTrackRow");

    const derivedService = await readFile(
      join(workspaceRoot, "apps/desktop/src/main/derived-media/service.ts"),
      "utf8",
    );
    for (const collaborator of [
      "DerivedArtifactRepository",
      "DerivedWriteCoordinator",
      "DerivedOperationQueue",
      "projectDerivedSnapshot",
    ])
      expect(derivedService).toContain(collaborator);
    expect(derivedService).not.toContain("new Map<string, WriterSession>");
    expect(derivedService).not.toContain("statfs(");
    const writeCoordinator = await readFile(
      join(workspaceRoot, "apps/desktop/src/main/derived-media/write-coordinator.ts"),
      "utf8",
    );
    expect(writeCoordinator).toContain("DerivedWriterRegistry");
    expect(writeCoordinator).toContain("validateFinalize");

    const app = await readFile(join(workspaceRoot, "apps/desktop/src/renderer/app.tsx"), "utf8");
    expect(app).toContain("useAppController");
    expect(app).not.toContain("useRendererStore(");
  });
});
