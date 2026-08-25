import { app } from "electron";

export interface ApplicationLifecycle {
  close(): Promise<void>;
}

export function installApplicationLifecycle(application: ApplicationLifecycle): void {
  let quitReady = false;
  let shutdown: Promise<void> | null = null;

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    shutdown ??= application.close().then(() => {
      quitReady = true;
      app.quit();
    });
  });
}
