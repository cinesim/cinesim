import { app } from "electron";
import { DesktopApplication, reportApplicationStartFailure } from "./app/application";
import { installApplicationLifecycle } from "./app/lifecycle";
import { desktopAccountScheme, DesktopAccountService } from "./account/service";
import { parseDevelopmentConfiguration } from "./app/development-configuration";
import { registerCinesimSchemes } from "./app/protocols";
import { EditorWindowRegistry } from "./app/editor-window-registry";

registerCinesimSchemes(desktopAccountScheme());

const windows = new EditorWindowRegistry();
const accountService = new DesktopAccountService(windows);
accountService.setupMain();
const development = parseDevelopmentConfiguration({
  isPackaged: app.isPackaged,
  rendererUrl: process.env.CINESIM_DEV_SERVER_URL,
  diagnosticProject: process.env.CINESIM_DIAGNOSTIC_PROJECT,
});
const application = new DesktopApplication(accountService, development, windows);
installApplicationLifecycle(application);

void application.start().catch((error: unknown) => {
  reportApplicationStartFailure(error);
  app.quit();
});
