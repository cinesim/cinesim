import { app, ipcMain } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { assertIpcSender } from "./ipc-security";

const trustedRendererIds = new Set<number>();
let developmentUrl: URL | undefined;

export function configureIpcSecurity(input: { developmentUrl: URL | null }): void {
  developmentUrl = input.developmentUrl ?? undefined;
}

export function trustIpcRenderer(webContents: WebContents): void {
  trustedRendererIds.add(webContents.id);
  webContents.once("destroyed", () => trustedRendererIds.delete(webContents.id));
}

export function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  assertIpcSender(event, {
    trustedRendererIds,
    developmentUrl,
    applicationPath: app.getAppPath(),
  });
}

export function registerIpcHandler<TArguments extends unknown[], TResult>(
  channel: string,
  handler: (...arguments_: TArguments) => TResult,
): void {
  ipcMain.handle(channel, (event, ...arguments_: unknown[]) => {
    assertTrustedIpcSender(event);
    return handler(...(arguments_ as TArguments));
  });
}
