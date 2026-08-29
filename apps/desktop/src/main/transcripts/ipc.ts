import { ipcMain } from "electron";
import type { TranscriptAudioChunkInput } from "../../shared/transcript";
import { parseDerivedProjectScope } from "../derived-media/ipc-validation";
import type { TranscriptStore } from "./service";

function parseAssetIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error("Invalid transcript asset selection");
  }
  return value as string[];
}

export function registerTranscriptIpc(store: TranscriptStore): void {
  ipcMain.handle("transcripts:get", (_event, scope: unknown, assetIds: unknown = []) =>
    store.snapshot(parseDerivedProjectScope(scope), parseAssetIds(assetIds)),
  );
  ipcMain.handle("transcripts:request", (_event, scope: unknown, assetIds: unknown) =>
    store.requestJobs(parseDerivedProjectScope(scope), parseAssetIds(assetIds)),
  );
  ipcMain.handle("transcripts:begin", (_event, scope: unknown, assetId: unknown) => {
    if (typeof assetId !== "string") throw new Error("Invalid transcript asset ID");
    return store.beginJob(parseDerivedProjectScope(scope), assetId);
  });
  ipcMain.handle("transcripts:chunk", (_event, scope: unknown, input: unknown) =>
    store.transcribeChunk(parseDerivedProjectScope(scope), input as TranscriptAudioChunkInput),
  );
  ipcMain.handle("transcripts:finalize", (_event, scope: unknown, jobId: unknown) => {
    if (typeof jobId !== "string") throw new Error("Invalid transcript job ID");
    return store.finalizeJob(parseDerivedProjectScope(scope), jobId);
  });
  ipcMain.handle(
    "transcripts:fail",
    (_event, scope: unknown, jobId: unknown, failureCode: unknown, detail: unknown) => {
      if (
        typeof jobId !== "string" ||
        typeof failureCode !== "string" ||
        (detail !== undefined && typeof detail !== "string")
      ) {
        throw new Error("Invalid transcript job failure");
      }
      return store.failJob(parseDerivedProjectScope(scope), jobId, failureCode, detail);
    },
  );
}
