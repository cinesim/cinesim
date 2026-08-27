import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Storage } from "@better-auth/electron/client";

interface StorageFile {
  version: 1;
  values: Record<string, unknown>;
}

export class DesktopAuthStorage implements Storage {
  readonly #path: string;
  #values: Record<string, unknown>;

  constructor(path: string) {
    this.#path = path;
    this.#values = this.#read();
  }

  getItem(name: string): unknown {
    return this.#values[name] ?? null;
  }

  setItem(name: string, value: unknown): void {
    this.#values[name] = value;
    this.#write();
  }

  #read(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StorageFile>;
      return parsed.version === 1 && parsed.values && typeof parsed.values === "object"
        ? parsed.values
        : {};
    } catch {
      return {};
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, values: this.#values } satisfies StorageFile, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, this.#path);
  }
}
