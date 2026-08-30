import { join } from "node:path";
import { app } from "electron";
import { createCinesimLogger } from "@cinesim/logging";
import type {
  AccountSnapshot,
  AccountUser,
  RegisteredProject,
  SignInMethod,
} from "../../shared/contracts";
import type { EditorWindowRegistry } from "../app/editor-window-registry";
import {
  BetterAuthAdapter,
  configuredAccountOrigin,
  desktopAccountScheme,
} from "./better-auth-adapter";
import type { AccountAuthAdapter } from "./better-auth-adapter";
import { DesktopAuthCallbackCoordinator } from "./callback-coordinator";
import { AccountGateway } from "./gateway";
import type { AccountResponse } from "./gateway";
import { AccountProfileRepository } from "./profile-repository";

declare const __CINESIM_CLOUD_ORIGIN__: string;

const log = createCinesimLogger({ service: "desktop-account" });

export { desktopAccountScheme } from "./better-auth-adapter";

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

export class DesktopAccountService {
  readonly #listeners = new Set<(snapshot: AccountSnapshot) => void>();
  readonly #profile: AccountProfileRepository;
  readonly #origin: string | null;
  readonly #client: AccountAuthAdapter | null;
  readonly #gateway: AccountGateway | null;
  readonly #callbacks: DesktopAuthCallbackCoordinator | null;
  #publishedKey: string | null = null;

  constructor(private readonly windows: EditorWindowRegistry) {
    this.#profile = new AccountProfileRepository(
      join(app.getPath("userData"), "account-profile.json"),
    );
    this.#origin = configuredAccountOrigin(__CINESIM_CLOUD_ORIGIN__);
    this.#client = this.#origin ? new BetterAuthAdapter(this.#origin) : null;
    this.#gateway =
      this.#origin && this.#client
        ? new AccountGateway(this.#origin, () => this.#client?.getCookie() ?? "")
        : null;
    this.#callbacks =
      this.#origin && this.#client
        ? new DesktopAuthCallbackCoordinator(
            this.#origin,
            desktopAccountScheme(),
            windows,
            (token) => this.#client!.authenticate(token),
          )
        : null;
  }

  setupMain(): void {
    this.#client?.setupMain(() => this.windows.primary());
    this.#callbacks?.setup();
  }

  async snapshot(): Promise<AccountSnapshot> {
    if (!this.#origin || !this.#client || !this.#gateway)
      return this.#publish(
        signedOutSnapshot({
          origin: null,
          available: false,
          detail: "Cloud authentication is not configured in this build.",
        }),
      );
    try {
      return await this.#onlineSnapshot(this.#gateway);
    } catch (error) {
      return this.#offlineSnapshot(this.#client, error);
    }
  }

  async #onlineSnapshot(gateway: AccountGateway): Promise<AccountSnapshot> {
    const account = await gateway.account();
    if (!account) {
      await this.#profile.clear();
      const health = await gateway.health();
      return this.#publish(
        signedOutSnapshot({
          origin: this.#origin,
          available: true,
          googleSignIn: health.googleSignIn,
          transcription: health.transcription,
        }),
      );
    }

    const health = await gateway.health();
    const user = this.#normalizeUser(account.user);
    await this.#profile.set(user);
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
  }

  #offlineSnapshot(client: AccountAuthAdapter, error: unknown): AccountSnapshot {
    log.warn(
      { err: error, operation: "account-snapshot" },
      "Account snapshot fell back to offline state",
    );
    const user = client.getCookie() ? this.#profile.get() : null;
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

  async beginSignIn(method: SignInMethod): Promise<void> {
    if (!this.#client || !this.#gateway)
      throw new Error("Cloud authentication is not configured in this build");
    if (method === "google" && !(await this.#gateway.health()).googleSignIn)
      throw new Error("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before using Google sign-in");
    await this.#client.requestAuth(method === "google" ? "google" : undefined);
  }

  async signOut(): Promise<AccountSnapshot> {
    if (!this.#client) return this.snapshot();
    await this.#client.signOut();
    await this.#profile.clear();
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

  registerProject(input: {
    cloudProjectId?: string | undefined;
    clientProjectId: string;
    name: string;
  }): Promise<RegisteredProject> {
    if (!this.#gateway) throw new Error("Cloud storage is not configured in this build");
    return this.#gateway.registerProject(input);
  }

  authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.#gateway) throw new Error("Cloud storage is not configured in this build");
    return this.#gateway.authenticatedFetch(path, init);
  }

  #normalizeUser(user: AccountResponse["user"]): AccountUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: null,
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
}
