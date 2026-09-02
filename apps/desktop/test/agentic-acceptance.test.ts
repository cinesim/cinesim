import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DesktopProjectSession } from "../src/shared/contracts";
import { DesktopProjectStore } from "../src/main/projects/project-store";

const temporaryDirectories: string[] = [];
const stores: DesktopProjectStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function waitForSession(
  store: DesktopProjectStore,
  predicate: (session: DesktopProjectSession) => boolean,
): Promise<DesktopProjectSession> {
  const current = store.session();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for a project watcher generation"));
    }, 5_000);
    const unsubscribe = store.subscribe((session) => {
      if (!predicate(session)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(session);
    });
  });
}

describe("cross-provider agentic acceptance", () => {
  it("shares guidance, compile acceptance, one history, and derived boundaries", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cinesim-agentic-acceptance-"));
    temporaryDirectories.push(parent);
    const store = new DesktopProjectStore();
    stores.push(store);
    store.setDefaultAgentInstructions(() => "Preserve speaker intent.");
    const created = await store.create(parent, "Provider acceptance");
    const sourcePath = join(created.directory, "main.jsx");

    const [agents, claude, claudeMcp, codex] = await Promise.all([
      readFile(join(created.directory, "AGENTS.md"), "utf8"),
      readFile(join(created.directory, "CLAUDE.md"), "utf8"),
      readFile(join(created.directory, ".mcp.json"), "utf8"),
      readFile(join(created.directory, ".codex/config.toml"), "utf8"),
    ]);
    expect(agents).toContain("Preserve speaker intent.");
    expect(claude).toBe("@AGENTS.md\n");
    expect(claudeMcp).toContain('"args": [\n        "mcp",\n        "--project",\n        "."');
    expect(codex).toContain('args = [ "mcp", "--project", "." ]');
    expect(`${claudeMcp}\n${codex}`).not.toMatch(/token|secret|port/iu);

    const initial = store.session();
    const initialSource = await readFile(sourcePath, "utf8");
    const codexSource = initialSource.replace('name="Main timeline"', 'name="Codex edit"');
    const acceptedPromise = waitForSession(
      store,
      (session) => session.diskValid && session.generation !== initial.generation,
    );
    await writeFile(sourcePath, codexSource, "utf8");
    const accepted = await acceptedPromise;
    expect(accepted).toMatchObject({ diskValid: true, canUndo: true, candidateDiagnostics: [] });

    const invalidPromise = waitForSession(store, (session) => !session.diskValid);
    await writeFile(sourcePath, "export const main = <composition", "utf8");
    const invalid = await invalidPromise;
    expect(invalid.generation).toBe(accepted.generation);
    expect(invalid.program).toEqual(accepted.program);
    expect(invalid.candidateDiagnostics.length).toBeGreaterThan(0);

    const claudeSource = codexSource.replace('name="Codex edit"', 'name="Claude edit"');
    const recoveredPromise = waitForSession(
      store,
      (session) => session.diskValid && session.generation !== accepted.generation,
    );
    await writeFile(sourcePath, claudeSource, "utf8");
    const recovered = await recoveredPromise;
    expect(recovered.candidateDiagnostics).toEqual([]);

    const undone = await store.undo();
    expect(await readFile(sourcePath, "utf8")).toBe(codexSource);
    expect(undone.canRedo).toBe(true);

    const beforeDerived = store.session();
    await store.visualIndex.clear([]);
    expect(store.session()).toMatchObject({
      generation: beforeDerived.generation,
      canUndo: beforeDerived.canUndo,
      canRedo: beforeDerived.canRedo,
    });
    await store.updateAgentGuidance("Use restrained pacing.");
    expect(store.session().generation).toBe(beforeDerived.generation);
  });
});
