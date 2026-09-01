import { watch, type FSWatcher } from "node:fs";
import type { IrDiagnostic } from "@cinesim/ir";
import { CompilerError } from "@cinesim/compiler";
import { SourceProjectRepository, type SourceProjectSnapshot } from "./source-project-repository";

export interface SourceWatcherEvents {
  accepted(snapshot: SourceProjectSnapshot): void | Promise<void>;
  diagnostics(diagnostics: IrDiagnostic[]): void | Promise<void>;
}

/** Project-scoped, hash/revision-based watcher. It never publishes an invalid compile. */
export class SourceProjectWatcher {
  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #acceptedGeneration: string;
  #hasReloadDiagnostics = false;
  #request = 0;

  constructor(
    private readonly repository: SourceProjectRepository,
    initial: SourceProjectSnapshot,
    private readonly events: SourceWatcherEvents,
    private readonly debounceMs = 75,
  ) {
    this.#acceptedGeneration = initial.generation;
  }

  start(): void {
    if (this.#watcher) return;
    this.#watcher = watch(this.repository.paths.root, { recursive: true }, (_event, filename) => {
      const relative = filename?.toString().replaceAll("\\", "/") ?? "";
      if (
        !relative ||
        relative.startsWith(".video/") ||
        (relative !== "cinesim.toml" &&
          relative !== "assets.toml" &&
          !/\.(?:js|jsx)$/u.test(relative))
      ) {
        return;
      }
      this.#schedule();
    });
  }

  acceptPublished(snapshot: SourceProjectSnapshot): void {
    this.#acceptedGeneration = snapshot.generation;
  }

  async checkNow(): Promise<void> {
    const request = ++this.#request;
    try {
      const snapshot = await this.repository.load();
      await this.#handleLoadedSnapshot(request, snapshot);
    } catch (error) {
      await this.#handleLoadFailure(request, error);
    }
  }

  async #handleLoadedSnapshot(request: number, snapshot: SourceProjectSnapshot): Promise<void> {
    if (request !== this.#request) return;
    if (snapshot.generation === this.#acceptedGeneration) {
      if (!this.#hasReloadDiagnostics) return;
      this.#hasReloadDiagnostics = false;
      await this.events.diagnostics([]);
      return;
    }
    this.#hasReloadDiagnostics = false;
    this.#acceptedGeneration = snapshot.generation;
    await this.events.accepted(snapshot);
  }

  async #handleLoadFailure(request: number, error: unknown): Promise<void> {
    if (request !== this.#request) return;
    this.#hasReloadDiagnostics = true;
    const diagnostic: IrDiagnostic =
      error instanceof CompilerError
        ? error.diagnostic
        : {
            severity: "error",
            code: "SOURCE_RELOAD_FAILED",
            message: error instanceof Error ? error.message : String(error),
          };
    await this.events.diagnostics([diagnostic]);
  }

  close(): void {
    this.#request += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.checkNow();
    }, this.debounceMs);
  }
}
