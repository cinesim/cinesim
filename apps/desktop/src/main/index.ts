import { app, protocol } from "electron";
import { DesktopApplication, reportApplicationStartFailure } from "./app/application";
import { installApplicationLifecycle } from "./app/lifecycle";
import { desktopAccountScheme, DesktopAccountService } from "./account/service";

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
const application = new DesktopApplication(accountService);
installApplicationLifecycle(application);

void application.start().catch((error: unknown) => {
  reportApplicationStartFailure(error);
  app.quit();
});
