import { app, ipcMain } from "electron";
import type { Logger } from "pino";
import type { MainEventLoopMonitor } from "./event-loop-monitor";
import { electronHealthSnapshot } from "./health";

export function registerAppIpc(log: Logger, monitor: MainEventLoopMonitor): void {
  let healthSamplingLogged = false;
  ipcMain.handle("app:health", () => {
    const snapshot = electronHealthSnapshot(app.getAppMetrics(), monitor.takeP95());
    if (!healthSamplingLogged) {
      healthSamplingLogged = true;
      log.info(
        {
          operation: "electron-health-sampling",
          processCount: snapshot.processCount,
          processGroups: Object.fromEntries(
            Object.entries(snapshot.processes).map(([kind, group]) => [kind, group.processCount]),
          ),
        },
        "Electron health sampling started",
      );
    }
    return snapshot;
  });
}
