import type { AgentManager } from "../agents/manager";
import type { DesktopAccountService } from "../account/service";
import type { CloudMediaManager } from "../cloud/manager";
import type { DesktopAppStateStore } from "../state/app-state-store";
import { registerIpcHandler } from "../app/secure-ipc";
import { projectContracts } from "./contracts";
import { ProjectIpcController } from "./ipc-controller";
import type { DesktopProjectStore } from "./project-store";

export function registerProjectIpc(
  store: DesktopProjectStore,
  appState: DesktopAppStateStore,
  agents: AgentManager,
  account: DesktopAccountService,
  cloudMedia: CloudMediaManager,
): void {
  const controller = new ProjectIpcController(store, appState, agents, account, cloudMedia);

  registerIpcHandler(projectContracts.chooseCreateLocation, () =>
    controller.chooseCreateLocation(),
  );
  registerIpcHandler(projectContracts.create, ({ name, kind, locationToken }) =>
    controller.create(name, kind, locationToken),
  );
  registerIpcHandler(projectContracts.open, () => controller.open());
  registerIpcHandler(projectContracts.openRecent, ({ directory }) =>
    controller.openRecent(directory),
  );
  registerIpcHandler(projectContracts.session, () => (store.project ? store.session() : null));
  registerIpcHandler(projectContracts.recentDetails, () => controller.recentDetails());
  registerIpcHandler(projectContracts.save, () => store.save());
  registerIpcHandler(projectContracts.settingsUpdate, ({ update }) =>
    controller.updateSettings(update),
  );
  registerIpcHandler(projectContracts.undo, () => store.undo());
  registerIpcHandler(projectContracts.redo, () => store.redo());
  registerIpcHandler(projectContracts.openTargets, () => controller.openTargets());
  registerIpcHandler(projectContracts.openWith, ({ target }) => controller.openWith(target));
  registerIpcHandler(projectContracts.forget, ({ directory }) => controller.forget(directory));
  registerIpcHandler(projectContracts.trash, ({ directory }) => controller.trash(directory));
  registerIpcHandler(projectContracts.importMedia, () => controller.importMedia());
  registerIpcHandler(projectContracts.execute, ({ command, expectedGeneration }) =>
    store.execute(command, expectedGeneration),
  );
}
