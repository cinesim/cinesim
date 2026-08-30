import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { allInvokeContracts } from "../src/main/app/all-contracts";
import { allEventChannels, allInvokeChannels } from "../src/shared/contracts/channels";
import { unwrapDesktopIpcResult } from "../src/shared/contracts/ipc";

const desktopSource = join(import.meta.dirname, "../src");

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
    const accountService = await readFile(join(desktopSource, "main/account/service.ts"), "utf8");
    expect(preload.match(/ipcRenderer\.invoke\(/gu)).toHaveLength(1);
    expect(secureIpc.match(/ipcMain\.handle\(/gu)).toHaveLength(1);
    expect(accountService).toContain("bridges: false");
    expect(accountService).not.toContain("bridges: true");
  });

  it("uses declared event names without duplicates", () => {
    expect(new Set(allEventChannels).size).toBe(allEventChannels.length);
  });
});
