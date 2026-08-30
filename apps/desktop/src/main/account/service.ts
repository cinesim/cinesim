import { join, resolve } from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";
import { electronClient } from "@better-auth/electron/client";
import { createCinesimLogger } from "@cinesim/logging";
import { createAuthClient } from "better-auth/client";
import { z } from "zod";
import type {
  AccountSnapshot,
  AccountUser,
  RegisteredProject,
  SignInMethod,
} from "../../shared/api";
import { parseDesktopAuthCallback } from "../../shared/auth-callback";
import { LocalAuthCallbackServer, LOCAL_AUTH_CALLBACK_PORT } from "./loopback-callback";
import { DesktopAuthStorage } from "./storage";
import { DesktopAccountProfileStore } from "./profile-store";

declare const __CINESIM_CLOUD_ORIGIN__: string;

const log = createCinesimLogger({ service: "desktop-auth" });

const accountResponseSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    name: z.string(),
    email: z.email(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
  }),
});

const healthResponseSchema = z.object({
  ok: z.literal(true),
  googleSignIn: z.boolean(),
  cloudStorage: z.boolean(),
  transcription: z.boolean(),
});

const registeredProjectSchema = z.object({
  id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/),
  clientProjectId: z.string().regex(/^project_[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  name: z.string().min(1),
});

function configuredOrigin(): string | null {
  const configured = __CINESIM_CLOUD_ORIGIN__.trim();
  if (configured) return new URL(configured).origin;
  return app.isPackaged ? null : "http://127.0.0.1:8787";
}

export function desktopAccountScheme(): string {
  return app.isPackaged ? "build.cinesim.desktop" : "build.cinesim.dev";
}

function signedOutSnapshot(input: {
  origin: string | null;
  available: boolean;
  googleSignIn?: boolean;
  transcription?: boolean;
  detail?: string;
}): AccountSnapshot {
  return {
    status: "signed-out",
    cloudOrigin: input.origin,
    serviceAvailable: input.available,
    googleSignIn: input.googleSignIn ?? false,
    cloudStorage: false,
    transcription: input.transcription ?? false,
    user: null,
    detail: input.detail ?? null,
  };
}

interface ElectronAuthClient {
  setupMain(config: {
    bridges: boolean;
    csp: boolean;
    scheme: boolean;
    getWindow: () => BrowserWindow | null;
  }): void;
  getCookie(): string;
  authenticate(input: { token: string }): Promise<{
    error: { message?: string | undefined } | null;
  }>;
  requestAuth(options?: { provider?: string }): Promise<void>;
  signOut(): Promise<{ error: { message?: string | undefined } | null }>;
}

export class DesktopAccountService {
  readonly #listeners = new Set<(snapshot: AccountSnapshot) => void>();
  #publishedKey: string | null = null;
  readonly #profile = new DesktopAccountProfileStore(
    join(app.getPath("userData"), "account-profile.json"),
  );
  readonly #origin = configuredOrigin();
  readonly #client: ElectronAuthClient | null = this.#origin
    ? (createAuthClient({
        baseURL: this.#origin,
        plugins: [
          // Better Auth 1.7.2's Electron plugin has an exact-optional type mismatch
          // with TypeScript 7. Runtime versions are pinned together and validated by tests.
          electronClient({
            signInURL: `${this.#origin}/sign-in`,
            protocol: { scheme: desktopAccountScheme() },
            clientID: "cinesim-desktop",
            channelPrefix: "cinesim-auth",
            storagePrefix: "cinesim-auth",
            storage: new DesktopAuthStorage(
              join(app.getPath("userData"), "account-session.json"),
              safeStorage,
            ),
            sanitizeUser: (user) => ({
              id: user.id,
              name: user.name,
              email: user.email,
              emailVerified: user.emailVerified,
              image: user.image,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            }),
          }) as never,
        ],
      }) as unknown as ElectronAuthClient)
    : null;
  readonly #loopback =
    !app.isPackaged && this.#origin && this.#client
      ? new LocalAuthCallbackServer({
          allowedOrigin: this.#origin,
          onToken: async (token) => {
            try {
              await this.#authenticateToken(token);
            } catch (error) {
              BrowserWindow.getAllWindows()[0]?.webContents.send("cinesim-auth:error");
              log.error(
                { err: error, operation: "auth-loopback-callback" },
                "Cinesim authentication callback failed",
              );
              throw error;
            }
          },
        })
      : null;

  setupMain(): void {
    this.#client?.setupMain({
      bridges: false,
      csp: false,
      scheme: false,
      getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    });
    this.#registerDeepLinks();
    if (this.#loopback) {
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
  }

  async snapshot(): Promise<AccountSnapshot> {
    if (!this.#origin || !this.#client)
      return this.#publish(
        signedOutSnapshot({
          origin: null,
          available: false,
          detail: "Cloud authentication is not configured in this build.",
        }),
      );

    const cookie = this.#client.getCookie();
    try {
      const response = await fetch(`${this.#origin}/api/v1/account`, {
        headers: { cookie },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401) {
        this.#profile.clear();
        const health = await this.#health();
        return this.#publish(
          signedOutSnapshot({
            origin: this.#origin,
            available: true,
            googleSignIn: health.googleSignIn,
            transcription: health.transcription,
          }),
        );
      }
      if (!response.ok) throw new Error(`Account endpoint returned ${response.status}`);
      const parsed = accountResponseSchema.parse(await response.json());
      const health = await this.#health();
      const user = this.#normalizeUser(parsed.user);
      this.#profile.set(user);
      return this.#publish({
        status: "signed-in",
        cloudOrigin: this.#origin,
        serviceAvailable: true,
        googleSignIn: health.googleSignIn,
        cloudStorage: health.cloudStorage,
        transcription: health.transcription,
        user,
        detail: null,
      });
    } catch {
      const user = cookie ? this.#profile.get() : null;
      return this.#publish({
        status: user ? "offline" : "signed-out",
        cloudOrigin: this.#origin,
        serviceAvailable: false,
        googleSignIn: false,
        cloudStorage: false,
        transcription: false,
        user,
        detail: user
          ? "Cinesim is offline. Local projects remain available and cloud work will resume automatically."
          : "The authentication service is unavailable. Local projects remain available without signing in.",
      });
    }
  }

  async beginSignIn(method: SignInMethod): Promise<void> {
    if (!this.#client) throw new Error("Cloud authentication is not configured in this build");
    if (method === "google") {
      const health = await this.#health();
      if (!health.googleSignIn)
        throw new Error(
          "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before using Google sign-in",
        );
    }
    await this.#client.requestAuth(method === "google" ? { provider: "google" } : undefined);
  }

  async signOut(): Promise<AccountSnapshot> {
    if (!this.#client) return this.snapshot();
    const result = await this.#client.signOut();
    if (result.error) throw new Error(result.error.message ?? "Could not sign out");
    this.#profile.clear();
    return this.snapshot();
  }

  cachedUser(): AccountUser | null {
    return this.#profile.get();
  }

  requireCachedUser(): AccountUser {
    const user = this.cachedUser();
    if (!user) throw new Error("Sign in before accessing cloud projects");
    return user;
  }

  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async registerProject(input: {
    cloudProjectId?: string | undefined;
    clientProjectId: string;
    name: string;
  }): Promise<RegisteredProject> {
    return registeredProjectSchema.parse(
      await (
        await this.authenticatedFetch("/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).json(),
    );
  }

  async authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/api/v1/")) throw new Error("Invalid Cinesim API path");
    if (!this.#origin || !this.#client)
      throw new Error("Cloud storage is not configured in this build");
    const cookie = this.#client.getCookie();
    if (!cookie) throw new Error("Sign in to use Cinesim Cloud storage");
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    const response = await fetch(`${this.#origin}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (response.status === 401) throw new Error("Sign in to use Cinesim Cloud storage");
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        message?: unknown;
        error?: unknown;
      } | null;
      throw new Error(
        typeof payload?.message === "string"
          ? payload.message
          : `Cinesim service request failed (${response.status})`,
      );
    }
    return response;
  }

  async #health(): Promise<{
    googleSignIn: boolean;
    cloudStorage: boolean;
    transcription: boolean;
  }> {
    if (!this.#origin) return { googleSignIn: false, cloudStorage: false, transcription: false };
    const response = await fetch(`${this.#origin}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
    return healthResponseSchema.parse(await response.json());
  }

  #normalizeUser(user: z.infer<typeof accountResponseSchema>["user"]): AccountUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image ? `user-image://${user.id}` : null,
    };
  }

  #publish(snapshot: AccountSnapshot): AccountSnapshot {
    const key = `${snapshot.status}:${snapshot.user?.id ?? "none"}:${snapshot.cloudStorage === true}`;
    if (key !== this.#publishedKey) {
      this.#publishedKey = key;
      for (const listener of this.#listeners) listener(snapshot);
    }
    return snapshot;
  }

  #registerDeepLinks(): void {
    if (!this.#client) return;
    const scheme = desktopAccountScheme();
    if (app.isPackaged) {
      if (process.defaultApp && process.argv[1])
        app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])]);
      else app.setAsDefaultProtocolClient(scheme);
    }

    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
      const target = BrowserWindow.getAllWindows()[0];
      if (target) {
        if (target.isMinimized()) target.restore();
        target.focus();
      }
      const candidate =
        typeof additionalData === "string" && additionalData
          ? additionalData
          : commandLine.find((argument) => argument.startsWith(`${scheme}:/`));
      if (candidate) this.#receiveDeepLink(candidate);
    });
    app.on("open-url", (event, url) => {
      event.preventDefault();
      this.#receiveDeepLink(url);
    });
    void app.whenReady().then(() => {
      const candidate = process.argv.find((argument) => argument.startsWith(`${scheme}:/`));
      if (candidate) this.#receiveDeepLink(candidate);
    });
  }

  #receiveDeepLink(value: string): void {
    void this.#handleDeepLink(value).catch((error: unknown) => {
      const target = BrowserWindow.getAllWindows()[0];
      target?.webContents.send("cinesim-auth:error");
      log.error(
        { err: error, operation: "auth-protocol-callback" },
        "Cinesim authentication callback failed",
      );
    });
  }

  async #handleDeepLink(value: string): Promise<void> {
    if (!this.#client) return;
    const token = parseDesktopAuthCallback(value, desktopAccountScheme());
    if (!token) return;
    await this.#authenticateToken(token);
  }

  async #authenticateToken(token: string): Promise<void> {
    if (!this.#client) return;
    const result = await this.#client.authenticate({ token });
    if (result.error) throw new Error(result.error.message ?? "Could not complete authentication");
    const target = BrowserWindow.getAllWindows()[0];
    if (target) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      target.webContents.send("cinesim-auth:authenticated");
    }
    log.info(
      { operation: app.isPackaged ? "auth-protocol-callback" : "auth-loopback-callback" },
      "Cinesim authentication callback completed",
    );
  }
}
