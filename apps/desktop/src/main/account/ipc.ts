import { BrowserWindow } from "electron";
import type { DesktopAccountService } from "./service";
import { accountContracts } from "./contracts";
import { eventChannels } from "../../shared/contracts/channels";
import { registerIpcHandler } from "../app/secure-ipc";

function broadcastAccountChanged(): void {
  for (const target of BrowserWindow.getAllWindows())
    target.webContents.send(eventChannels.accountChanged);
}

export function registerAccountIpc(
  service: DesktopAccountService,
  onSignOut: () => Promise<void>,
): void {
  registerIpcHandler(accountContracts.get, () => service.snapshot());
  registerIpcHandler(accountContracts.signIn, async ({ method }) => {
    await service.beginSignIn(method);
  });
  registerIpcHandler(accountContracts.signOut, async () => {
    const snapshot = await service.signOut();
    await onSignOut();
    broadcastAccountChanged();
    return snapshot;
  });
}
