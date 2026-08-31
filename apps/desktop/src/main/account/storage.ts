import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Storage } from "@better-auth/electron/client";
import { z } from "zod";

interface EncryptedStorageFile {
  version: 2;
  protection: "electron-safe-storage";
  ciphertext: string;
}

interface SecretPayload {
  values: Record<string, unknown>;
}

const MAX_AUTH_STORAGE_BYTES = 1024 * 1024;
const valuesSchema = z.record(z.string().min(1).max(4_096), z.unknown());
const encryptedStorageSchema = z
  .object({
    version: z.literal(2),
    protection: z.literal("electron-safe-storage"),
    ciphertext: z.string().max(MAX_AUTH_STORAGE_BYTES),
  })
  .strict();
const secretPayloadSchema = z.object({ values: valuesSchema }).strict();

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
      const metadata = statSync(this.#path);
      if (!metadata.isFile() || metadata.size > MAX_AUTH_STORAGE_BYTES) throw new Error();
      const raw = JSON.parse(readFileSync(this.#path, "utf8"));
      const encrypted = encryptedStorageSchema.safeParse(raw);
      if (!encrypted.success || !this.#safeStorage.isEncryptionAvailable()) {
        this.#values = {};
        return this.#values;
      }
      const plaintext = this.#safeStorage.decryptString(
        Buffer.from(encrypted.data.ciphertext, "base64"),
      );
      if (Buffer.byteLength(plaintext, "utf8") > MAX_AUTH_STORAGE_BYTES) throw new Error();
      this.#values = secretPayloadSchema.parse(JSON.parse(plaintext)).values;
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
    if (ciphertext.length > MAX_AUTH_STORAGE_BYTES)
      throw new Error("Authentication storage exceeded its byte limit");
    try {
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
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original failure; the randomized temporary file contains only ciphertext.
      }
      throw error;
    }
  }
}
