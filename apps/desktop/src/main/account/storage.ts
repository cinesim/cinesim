import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Storage } from "@better-auth/electron/client";

interface LegacyStorageFile {
  version: 1;
  values: Record<string, unknown>;
}

interface EncryptedStorageFile {
  version: 2;
  protection: "electron-safe-storage";
  ciphertext: string;
}

interface SecretPayload {
  values: Record<string, unknown>;
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class DesktopAuthStorage implements Storage {
  readonly #path: string;
  readonly #safeStorage: SafeStorageAdapter;
  #values: Record<string, unknown> | null = null;

  constructor(path: string, safeStorage: SafeStorageAdapter) {
    this.#path = path;
    this.#safeStorage = safeStorage;
  }

  getItem(name: string): unknown {
    return this.#load()[name] ?? null;
  }

  setItem(name: string, value: unknown): void {
    this.#load()[name] = value;
    this.#write();
  }

  #load(): Record<string, unknown> {
    if (this.#values) return this.#values;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as
        | Partial<LegacyStorageFile>
        | Partial<EncryptedStorageFile>;
      if (parsed.version === 1 && parsed.values && typeof parsed.values === "object") {
        this.#values = parsed.values;
        return this.#values;
      }
      if (
        parsed.version !== 2 ||
        parsed.protection !== "electron-safe-storage" ||
        typeof parsed.ciphertext !== "string" ||
        !this.#safeStorage.isEncryptionAvailable()
      ) {
        this.#values = {};
        return this.#values;
      }
      const plaintext = this.#safeStorage.decryptString(Buffer.from(parsed.ciphertext, "base64"));
      const payload = JSON.parse(plaintext) as Partial<SecretPayload>;
      this.#values =
        payload.values && typeof payload.values === "object" && !Array.isArray(payload.values)
          ? payload.values
          : {};
      return this.#values;
    } catch {
      this.#values = {};
      return this.#values;
    }
  }

  #write(): void {
    if (!this.#safeStorage.isEncryptionAvailable())
      throw new Error("OS credential protection is unavailable; authentication was not saved");
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const ciphertext = this.#safeStorage
      .encryptString(JSON.stringify({ values: this.#load() } satisfies SecretPayload))
      .toString("base64");
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          version: 2,
          protection: "electron-safe-storage",
          ciphertext,
        } satisfies EncryptedStorageFile,
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, this.#path);
  }
}
