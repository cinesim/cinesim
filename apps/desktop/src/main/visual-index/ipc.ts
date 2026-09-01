import type { DesktopProjectStore } from "../projects/project-store";
import { registerIpcHandler } from "../app/secure-ipc";
import { visualIndexContracts } from "./contracts";

export function registerVisualIndexIpc(store: DesktopProjectStore): void {
  const assertScope = (scope: Parameters<typeof store.derivedMedia.assertScope>[0]) =>
    store.derivedMedia.assertScope(scope);
  registerIpcHandler(visualIndexContracts.status, ({ scope, assetIds }) => {
    assertScope(scope);
    return store.visualIndex.status(assetIds);
  });
  registerIpcHandler(visualIndexContracts.get, ({ scope, assetId, range }) => {
    assertScope(scope);
    return store.visualIndex.get(assetId, {
      ...(range?.fromUs === undefined ? {} : { fromUs: range.fromUs }),
      ...(range?.toUs === undefined ? {} : { toUs: range.toUs }),
      ...(range?.limit === undefined ? {} : { limit: range.limit }),
    });
  });
  registerIpcHandler(visualIndexContracts.generate, ({ scope, assetIds }) => {
    assertScope(scope);
    return store.visualIndex.generate(assetIds);
  });
  registerIpcHandler(visualIndexContracts.regenerate, ({ scope, assetIds }) => {
    assertScope(scope);
    return store.visualIndex.generate(assetIds, true);
  });
  registerIpcHandler(visualIndexContracts.upsert, ({ scope, assetId, observations }) => {
    assertScope(scope);
    return store.visualIndex.upsert(assetId, observations);
  });
  registerIpcHandler(visualIndexContracts.delete, ({ scope, assetId, selector }) => {
    assertScope(scope);
    return store.visualIndex.delete(assetId, {
      ...(selector.observationIds === undefined ? {} : { observationIds: selector.observationIds }),
      ...(selector.fromUs === undefined ? {} : { fromUs: selector.fromUs }),
      ...(selector.toUs === undefined ? {} : { toUs: selector.toUs }),
    });
  });
  registerIpcHandler(visualIndexContracts.clear, ({ scope, assetIds }) => {
    assertScope(scope);
    return store.visualIndex.clear(assetIds);
  });
}
