import type { DesktopAccountService } from "./service";
import { accountContracts } from "./contracts";
import { desktopEvents } from "../../shared/contracts/events";
import { registerIpcHandler } from "../app/secure-ipc";
import type { EditorWindowRegistry } from "../app/editor-window-registry";

export function registerAccountIpc(
  service: DesktopAccountService,
  windows: EditorWindowRegistry,
  onSignOut: () => Promise<void>,
): void {
  registerIpcHandler(accountContracts.get, () => service.snapshot());
  registerIpcHandler(accountContracts.signIn, async ({ method }) => {
    await service.beginSignIn(method);
  });
  registerIpcHandler(accountContracts.signOut, async () => {
    const snapshot = await service.signOut();
    await onSignOut();
    windows.broadcast(desktopEvents.accountChanged);
    return snapshot;
  });
}
