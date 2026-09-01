import type { VisualAnalysisService } from "./service";
import { registerIpcHandler } from "../app/secure-ipc";
import { visualAnalysisContracts } from "./contracts";

export function registerVisualAnalysisIpc(service: VisualAnalysisService): void {
  registerIpcHandler(visualAnalysisContracts.complete, ({ scope, completion }) =>
    service.complete(scope, completion),
  );
  registerIpcHandler(visualAnalysisContracts.fail, ({ scope, failure }) =>
    service.fail(scope, failure),
  );
}
