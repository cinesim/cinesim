import type { DerivedMediaStore } from "./service";
import {
  beginDerivedWriteSchema,
  derivedPerformanceObservationSchema,
  finalizeDerivedWriteSchema,
  parseDerivedProjectScope,
  parseDerivedWorkerActivity,
} from "./ipc-validation";
import { registerIpcHandler } from "../app/secure-ipc";

export function registerDerivedMediaIpc(store: DerivedMediaStore): void {
  registerIpcHandler("derived:get", (scope: unknown) => {
    store.assertScope(parseDerivedProjectScope(scope));
    return store.snapshot();
  });
  registerIpcHandler("derived:request-jobs", (scope: unknown, assetIds: unknown) => {
    if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string"))
      throw new Error("Invalid derived job request");
    return store.requestJobs(parseDerivedProjectScope(scope), assetIds);
  });
  registerIpcHandler("derived:request-proxies", (scope: unknown, assetIds: unknown) => {
    if (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== "string"))
      throw new Error("Invalid proxy job request");
    return store.queueProxies(parseDerivedProjectScope(scope), assetIds);
  });
  registerIpcHandler("derived:write:begin", (scope: unknown, input: unknown) =>
    store.beginWrite(parseDerivedProjectScope(scope), beginDerivedWriteSchema.parse(input)),
  );
  registerIpcHandler("derived:write:chunk", (writerId: unknown, offset: unknown, data: unknown) => {
    if (typeof writerId !== "string" || typeof offset !== "number" || !(data instanceof Uint8Array))
      throw new Error("Invalid derived write chunk");
    return store.writeChunk(writerId, offset, data);
  });
  registerIpcHandler("derived:write:finalize", (writerId: unknown, result: unknown) => {
    if (typeof writerId !== "string") throw new Error("Invalid derived writer");
    return store.finalizeWrite(writerId, finalizeDerivedWriteSchema.parse(result));
  });
  registerIpcHandler(
    "derived:write:cancel",
    (writerId: unknown, failureCode: unknown, detail: unknown) => {
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
  registerIpcHandler("derived:write:progress", (writerId: unknown, progress: unknown) => {
    if (typeof writerId !== "string" || typeof progress !== "number")
      throw new Error("Invalid derived progress");
    return store.updateProgress(writerId, progress);
  });
  registerIpcHandler("derived:activity", (scope: unknown, activity: unknown) =>
    store.reportActivity(parseDerivedProjectScope(scope), parseDerivedWorkerActivity(activity)),
  );
  registerIpcHandler("derived:performance", (scope: unknown, observation: unknown) =>
    store.reportPerformance(
      parseDerivedProjectScope(scope),
      derivedPerformanceObservationSchema.parse(observation),
    ),
  );
}
