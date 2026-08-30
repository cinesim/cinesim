import { app, protocol } from "electron";
import { DesktopApplication, reportApplicationStartFailure } from "./app/application";
import { installApplicationLifecycle } from "./app/lifecycle";
import { desktopAccountScheme, DesktopAccountService } from "./account/service";
import { parseDevelopmentConfiguration } from "./app/development-configuration";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "cinesim-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: desktopAccountScheme(),
    privileges: {
      secure: true,
    },
  },
]);

const accountService = new DesktopAccountService();
accountService.setupMain();
const development = parseDevelopmentConfiguration({
  isPackaged: app.isPackaged,
  rendererUrl: process.env.CINESIM_DEV_SERVER_URL,
  diagnosticProject: process.env.CINESIM_DIAGNOSTIC_PROJECT,
});
const application = new DesktopApplication(accountService, development);
installApplicationLifecycle(application);

void application.start().catch((error: unknown) => {
  reportApplicationStartFailure(error);
  app.quit();
});
