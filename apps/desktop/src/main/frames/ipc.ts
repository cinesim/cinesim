import type { FrameService } from "./service";
import { registerIpcHandler } from "../app/secure-ipc";
import { frameContracts } from "./contracts";

export function registerFrameIpc(service: FrameService): void {
  registerIpcHandler(frameContracts.complete, ({ scope, completion }) =>
    service.complete(scope, completion),
  );
  registerIpcHandler(frameContracts.fail, ({ scope, failure }) => service.fail(scope, failure));
}
