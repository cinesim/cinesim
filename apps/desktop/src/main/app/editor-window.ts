import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";

export function createEditorWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f9f9f9",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const developmentUrl = process.env.CINESIM_DEV_SERVER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
  return window;
}
