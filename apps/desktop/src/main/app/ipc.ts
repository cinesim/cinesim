import { app } from "electron";
import type { Logger } from "pino";
import type { MainEventLoopMonitor } from "./event-loop-monitor";
import { electronHealthSnapshot } from "./health";
import { registerIpcHandler } from "./secure-ipc";
import { appContracts } from "./contracts";

export function registerAppIpc(log: Logger, monitor: MainEventLoopMonitor): void {
  let healthSamplingLogged = false;
  registerIpcHandler(appContracts.health, () => {
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
