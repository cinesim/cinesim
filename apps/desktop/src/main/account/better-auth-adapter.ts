import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { BrowserWindow } from "electron";
import { electronClient } from "@better-auth/electron/client";
import { createAuthClient } from "better-auth/client";
import { DesktopAuthStorage } from "./storage";

export interface AccountAuthAdapter {
  setupMain(getWindow: () => BrowserWindow | null): void;
  getCookie(): string;
  authenticate(token: string): Promise<void>;
  requestAuth(provider?: "google"): Promise<void>;
  signOut(): Promise<void>;
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

export function desktopAccountScheme(): string {
  return app.isPackaged ? "build.cinesim.desktop" : "build.cinesim.dev";
}

export function configuredAccountOrigin(configuredValue: string): string | null {
  const configured = configuredValue.trim();
  if (configured) return new URL(configured).origin;
  return app.isPackaged ? null : "http://127.0.0.1:8787";
}

export class BetterAuthAdapter implements AccountAuthAdapter {
  readonly #client: ElectronAuthClient;

  constructor(origin: string) {
    this.#client = createAuthClient({
      baseURL: origin,
      plugins: [
        // Better Auth 1.7.2's Electron plugin has an exact-optional type mismatch
        // with TypeScript 7. The cast is isolated here and runtime behavior is covered by tests.
        electronClient({
          signInURL: `${origin}/sign-in`,
          protocol: { scheme: desktopAccountScheme() },
          clientID: "cinesim-desktop",
          channelPrefix: "cinesim-auth",
          storagePrefix: "cinesim-auth",
          userImageProxy: { enabled: false },
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
    }) as unknown as ElectronAuthClient;
  }

  setupMain(getWindow: () => BrowserWindow | null): void {
    this.#client.setupMain({ bridges: false, csp: false, scheme: false, getWindow });
  }

  getCookie(): string {
    return this.#client.getCookie();
  }

  async authenticate(token: string): Promise<void> {
    const result = await this.#client.authenticate({ token });
    if (result.error) throw new Error(result.error.message ?? "Could not complete authentication");
  }

  requestAuth(provider?: "google"): Promise<void> {
    return this.#client.requestAuth(provider ? { provider } : undefined);
  }

  async signOut(): Promise<void> {
    const result = await this.#client.signOut();
    if (result.error) throw new Error(result.error.message ?? "Could not sign out");
  }
}
