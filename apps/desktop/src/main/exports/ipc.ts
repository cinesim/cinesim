import { registerIpcHandler } from "../app/secure-ipc";
import type { ExportService } from "./service";
import { exportContracts } from "./contracts";

export function registerExportIpc(service: ExportService): void {
  registerIpcHandler(exportContracts.capabilities, () => service.capabilities());
  registerIpcHandler(exportContracts.status, ({ jobId }) => service.status(jobId));
  registerIpcHandler(exportContracts.start, (request) => service.start(request));
  registerIpcHandler(exportContracts.cancel, ({ jobId }) => service.cancel(jobId));
  registerIpcHandler(exportContracts.writeChunk, ({ jobId, offset, data }) =>
    service.writeChunk(jobId, offset, data),
  );
  registerIpcHandler(exportContracts.progress, ({ jobId, progress }) =>
    service.updateProgress(jobId, progress),
  );
  registerIpcHandler(exportContracts.complete, (completion) => service.complete(completion));
  registerIpcHandler(exportContracts.fail, ({ jobId, code, detail }) =>
    service.fail(jobId, code, detail),
  );
}
