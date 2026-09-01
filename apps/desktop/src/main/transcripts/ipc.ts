import type { TranscriptStore } from "./service";
import { registerIpcHandler } from "../app/secure-ipc";
import { transcriptContracts } from "./contracts";

export function registerTranscriptIpc(store: TranscriptStore): void {
  registerIpcHandler(transcriptContracts.get, ({ scope, assetIds }) =>
    store.snapshot(scope, assetIds),
  );
  registerIpcHandler(transcriptContracts.request, ({ scope, assetIds }) =>
    store.requestJobs(scope, assetIds),
  );
  registerIpcHandler(transcriptContracts.regenerate, ({ scope, assetIds }) =>
    store.regenerateJobs(scope, assetIds),
  );
  registerIpcHandler(transcriptContracts.cancel, ({ scope, assetIds }) =>
    store.cancelJobs(scope, assetIds),
  );
  registerIpcHandler(transcriptContracts.begin, ({ scope, assetId }) => {
    return store.beginJob(scope, assetId);
  });
  registerIpcHandler(transcriptContracts.chunk, ({ scope, input }) =>
    store.transcribeChunk(scope, input),
  );
  registerIpcHandler(transcriptContracts.finalize, ({ scope, jobId }) => {
    return store.finalizeJob(scope, jobId);
  });
  registerIpcHandler(transcriptContracts.fail, ({ scope, jobId, failureCode, detail }) => {
    return store.failJob(scope, jobId, failureCode, detail);
  });
}
