import { resolve } from "node:path";
import { app } from "electron";
import { createCinesimLogger } from "@cinesim/logging";
import { parseDesktopAuthCallback } from "../../shared/auth-callback";
import { desktopEvents } from "../../shared/contracts/events";
import type { EditorWindowRegistry } from "../app/editor-window-registry";
import { LocalAuthCallbackServer, LOCAL_AUTH_CALLBACK_PORT } from "./loopback-callback";

const log = createCinesimLogger({ service: "desktop-auth-callback" });

export class DesktopAuthCallbackCoordinator {
  readonly #loopback: LocalAuthCallbackServer | null;

  constructor(
    private readonly origin: string,
    private readonly scheme: string,
    private readonly windows: EditorWindowRegistry,
    private readonly authenticateToken: (token: string) => Promise<void>,
  ) {
    this.#loopback = app.isPackaged
      ? null
      : new LocalAuthCallbackServer({
          allowedOrigin: origin,
          onToken: (token) => this.#complete(token, "auth-loopback-callback"),
        });
  }

  setup(): void {
    this.#registerDeepLinks();
    if (!this.#loopback) return;
    void this.#loopback
      .start()
      .then((port) =>
        log.info(
          { operation: "auth-loopback-listen", port },
          "Local desktop authentication callback is ready",
        ),
      )
      .catch((error: unknown) =>
        log.error(
          { err: error, operation: "auth-loopback-listen", port: LOCAL_AUTH_CALLBACK_PORT },
          "Local desktop authentication callback could not start",
        ),
      );
    app.once("will-quit", () => {
      void this.#loopback
        ?.close()
        .catch((error: unknown) =>
          log.error(
            { err: error, operation: "auth-loopback-close" },
            "Local desktop authentication callback could not close cleanly",
          ),
        );
    });
  }

  #registerDeepLinks(): void {
    if (app.isPackaged) {
      if (process.defaultApp && process.argv[1])
        app.setAsDefaultProtocolClient(this.scheme, process.execPath, [resolve(process.argv[1])]);
      else app.setAsDefaultProtocolClient(this.scheme);
    }
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
      this.windows.focusPrimary();
      const candidate =
        typeof additionalData === "string" && additionalData
          ? additionalData
          : commandLine.find((argument) => argument.startsWith(`${this.scheme}:/`));
      if (candidate) this.#receive(candidate);
    });
    app.on("open-url", (event, url) => {
      event.preventDefault();
      this.#receive(url);
    });
    void app.whenReady().then(() => {
      const candidate = process.argv.find((argument) => argument.startsWith(`${this.scheme}:/`));
      if (candidate) this.#receive(candidate);
    });
  }

  #receive(value: string): void {
    const token = parseDesktopAuthCallback(value, this.scheme);
    if (token)
      void this.#complete(token, "auth-protocol-callback").catch(() => {
        // Completion logs and publishes the failure; protocol event handlers cannot await it.
      });
  }

  async #complete(token: string, operation: string): Promise<void> {
    try {
      await this.authenticateToken(token);
      this.windows.focusPrimary({ show: true });
      this.windows.sendPrimary(desktopEvents.authAuthenticated);
      log.info({ operation }, "Cinesim authentication callback completed");
    } catch (error) {
      this.windows.sendPrimary(desktopEvents.authError);
      log.error({ err: error, operation }, "Cinesim authentication callback failed");
      throw error;
    }
  }
}
