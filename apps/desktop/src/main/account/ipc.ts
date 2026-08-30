import { BrowserWindow } from "electron";
import type { DesktopAccountService } from "./service";
import { registerIpcHandler } from "../app/secure-ipc";

function broadcastAccountChanged(): void {
  for (const target of BrowserWindow.getAllWindows()) target.webContents.send("account:changed");
}

export function registerAccountIpc(
  service: DesktopAccountService,
  onSignOut: () => Promise<void>,
): void {
  registerIpcHandler("account:get", () => service.snapshot());
  registerIpcHandler("account:sign-in", async (method: unknown) => {
    if (method !== "email" && method !== "google") throw new Error("Invalid sign-in method");
    await service.beginSignIn(method);
  });
  registerIpcHandler("account:sign-out", async () => {
    const snapshot = await service.signOut();
    await onSignOut();
    broadcastAccountChanged();
    return snapshot;
  });
}
