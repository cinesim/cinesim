import { app, protocol } from "electron";
import { DesktopApplication, reportApplicationStartFailure } from "./app/application";
import { installApplicationLifecycle } from "./app/lifecycle";

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
]);

const application = new DesktopApplication();
installApplicationLifecycle(application);

void application.start().catch((error: unknown) => {
  reportApplicationStartFailure(error);
  app.quit();
});
