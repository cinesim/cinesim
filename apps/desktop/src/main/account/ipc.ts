import { BrowserWindow, ipcMain } from "electron";
import type { DesktopAccountService } from "./service";

function broadcastAccountChanged(): void {
  for (const target of BrowserWindow.getAllWindows()) target.webContents.send("account:changed");
}

export function registerAccountIpc(service: DesktopAccountService): void {
  ipcMain.handle("account:get", () => service.snapshot());
  ipcMain.handle("account:sign-in", async (_event, method: unknown) => {
    if (method !== "email" && method !== "google") throw new Error("Invalid sign-in method");
    await service.beginSignIn(method);
  });
  ipcMain.handle("account:sign-out", async () => {
    const snapshot = await service.signOut();
    broadcastAccountChanged();
    return snapshot;
  });
}
