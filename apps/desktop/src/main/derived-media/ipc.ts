import { ipcMain } from "electron";
import type {
  BeginDerivedWrite,
  DerivedPerformanceObservation,
  FinalizeDerivedWrite,
} from "../../shared/api";
import type { DerivedMediaStore } from "./service";
import { parseDerivedProjectScope, parseDerivedWorkerActivity } from "./ipc-validation";

export function registerDerivedMediaIpc(store: DerivedMediaStore): void {
  ipcMain.handle("derived:get", (_event, scope: unknown) => {
    store.assertScope(parseDerivedProjectScope(scope));
    return store.snapshot();
  });
  ipcMain.handle("derived:request-jobs", (_event, scope: unknown, assetIds: unknown) => {
    if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string"))
      throw new Error("Invalid derived job request");
    return store.requestJobs(parseDerivedProjectScope(scope), assetIds);
  });
  ipcMain.handle("derived:request-proxies", (_event, scope: unknown, assetIds: unknown) => {
    if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string"))
      throw new Error("Invalid proxy job request");
    return store.queueProxies(parseDerivedProjectScope(scope), assetIds);
  });
  ipcMain.handle("derived:write:begin", (_event, scope: unknown, input: unknown) =>
    store.beginWrite(parseDerivedProjectScope(scope), input as BeginDerivedWrite),
  );
  ipcMain.handle(
    "derived:write:chunk",
    (_event, writerId: unknown, offset: unknown, data: unknown) => {
      if (
        typeof writerId !== "string" ||
        typeof offset !== "number" ||
        !(data instanceof Uint8Array)
      )
        throw new Error("Invalid derived write chunk");
      return store.writeChunk(writerId, offset, data);
    },
  );
  ipcMain.handle("derived:write:finalize", (_event, writerId: unknown, result: unknown) => {
    if (typeof writerId !== "string") throw new Error("Invalid derived writer");
    return store.finalizeWrite(writerId, result as FinalizeDerivedWrite);
  });
  ipcMain.handle(
    "derived:write:cancel",
    (_event, writerId: unknown, failureCode: unknown, detail: unknown) => {
      if (
        typeof writerId !== "string" ||
        (failureCode !== undefined &&
          (typeof failureCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(failureCode))) ||
        (detail !== undefined && (typeof detail !== "string" || detail.length > 2_000))
      )
        throw new Error("Invalid derived writer cancellation");
      return store.cancelWrite(writerId, failureCode, detail);
    },
  );
  ipcMain.handle("derived:write:progress", (_event, writerId: unknown, progress: unknown) => {
    if (typeof writerId !== "string" || typeof progress !== "number")
      throw new Error("Invalid derived progress");
    return store.updateProgress(writerId, progress);
  });
  ipcMain.handle("derived:activity", (_event, scope: unknown, activity: unknown) =>
    store.reportActivity(parseDerivedProjectScope(scope), parseDerivedWorkerActivity(activity)),
  );
  ipcMain.handle("derived:performance", (_event, scope: unknown, observation: unknown) =>
    store.reportPerformance(
      parseDerivedProjectScope(scope),
      observation as DerivedPerformanceObservation,
    ),
  );
}
