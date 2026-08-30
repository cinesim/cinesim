import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { allInvokeContracts } from "../src/main/app/all-contracts";
import { allEventChannels, allInvokeChannels } from "../src/shared/contracts/channels";
import { unwrapDesktopIpcResult } from "../src/shared/contracts/ipc";

const desktopSource = join(import.meta.dirname, "../src");

async function typescriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? typescriptSources(path)
          : Promise.resolve(/\.tsx?$/u.test(entry.name) ? [path] : []);
      }),
    )
  ).flat();
}

describe("desktop IPC contracts", () => {
  it("declares every invoke channel exactly once", () => {
    const channels = allInvokeContracts.map((contract) => contract.channel);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.toSorted()).toEqual([...allInvokeChannels].toSorted());
  });

  it("parses invalid input before a handler can receive it", () => {
    const openRecent = allInvokeContracts.find(
      (contract) => contract.channel === "project:open-recent",
    );
    expect(() => openRecent?.request.parse(["x".repeat(4_097)])).toThrow();
  });

  it("preserves structured error identity for renderer code", () => {
    expect(() =>
      unwrapDesktopIpcResult({
        ok: false,
        error: {
          code: "CONFLICT",
          message: "The project revision is stale",
          operationId: "operation-1",
          retryable: true,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        operationId: "operation-1",
        retryable: true,
      }),
    );
  });

  it("keeps raw Electron IPC primitives inside the guarded boundary", async () => {
    const preload = await readFile(join(desktopSource, "preload/index.ts"), "utf8");
    const secureIpc = await readFile(join(desktopSource, "main/app/secure-ipc.ts"), "utf8");
    const accountAdapter = await readFile(
      join(desktopSource, "main/account/better-auth-adapter.ts"),
      "utf8",
    );
    expect(preload.match(/ipcRenderer\.invoke\(/gu)).toHaveLength(1);
    expect(secureIpc.match(/ipcMain\.handle\(/gu)).toHaveLength(1);
    expect(accountAdapter).toContain("bridges: false");
    expect(accountAdapter).not.toContain("bridges: true");

    const rawPrimitive =
      /(?:ipcMain\.(?:handle|on)|ipcRenderer\.(?:invoke|on|send)|webContents\.send)\(/u;
    const allowedFiles = new Set([
      join(desktopSource, "main/app/editor-window-registry.ts"),
      join(desktopSource, "main/app/secure-ipc.ts"),
      join(desktopSource, "preload/index.ts"),
    ]);
    for (const path of await typescriptSources(desktopSource)) {
      const source = await readFile(path, "utf8");
      if (rawPrimitive.test(source)) expect(allowedFiles.has(path), path).toBe(true);
    }
  });

  it("owns the complete privileged scheme inventory", async () => {
    const protocolManifest = await readFile(join(desktopSource, "main/app/protocols.ts"), "utf8");
    const accountAdapter = await readFile(
      join(desktopSource, "main/account/better-auth-adapter.ts"),
      "utf8",
    );
    expect(protocolManifest.match(/registerSchemesAsPrivileged\(/gu)).toHaveLength(1);
    expect(protocolManifest).not.toContain("bypassCSP");
    expect(accountAdapter).toContain("userImageProxy: { enabled: false }");
    for (const path of await typescriptSources(join(desktopSource, "main"))) {
      if (path.endsWith("/app/protocols.ts")) continue;
      expect(await readFile(path, "utf8"), path).not.toContain("registerSchemesAsPrivileged(");
    }
  });

  it("uses declared event names without duplicates", () => {
    expect(new Set(allEventChannels).size).toBe(allEventChannels.length);
  });
});
