import type { DerivedMediaStore } from "./service";
import { registerIpcHandler } from "../app/secure-ipc";
import { derivedContracts } from "./contracts";

export function registerDerivedMediaIpc(store: DerivedMediaStore): void {
  registerIpcHandler(derivedContracts.get, ({ scope }) => {
    store.assertScope(scope);
    return store.snapshot();
  });
  registerIpcHandler(derivedContracts.requestJobs, ({ scope, assetIds }) => {
    return store.requestJobs(scope, assetIds);
  });
  registerIpcHandler(derivedContracts.requestProxies, ({ scope, assetIds }) => {
    return store.queueProxies(scope, assetIds);
  });
  registerIpcHandler(derivedContracts.writeBegin, ({ scope, input }) =>
    store.beginWrite(scope, input),
  );
  registerIpcHandler(derivedContracts.writeChunk, ({ writerId, offset, data }) => {
    return store.writeChunk(writerId, offset, data);
  });
  registerIpcHandler(derivedContracts.writeFinalize, ({ writerId, result }) => {
    return store.finalizeWrite(writerId, result);
  });
  registerIpcHandler(derivedContracts.writeCancel, ({ writerId, failureCode, detail }) => {
    return store.cancelWrite(writerId, failureCode, detail);
  });
  registerIpcHandler(derivedContracts.writeProgress, ({ writerId, progress }) => {
    return store.updateProgress(writerId, progress);
  });
  registerIpcHandler(derivedContracts.activity, ({ scope, activity }) =>
    store.reportActivity(scope, activity),
  );
  registerIpcHandler(derivedContracts.performance, ({ scope, observation }) =>
    store.reportPerformance(scope, observation),
  );
}
