import { MAX_ACTIVE_UPLOADS } from "./limits";

interface ScheduledUpload {
  key: string;
  run(signal: AbortSignal): Promise<void>;
  settled(error: unknown, aborted: boolean): Promise<void> | void;
}

export class CloudUploadScheduler {
  readonly #pending = new Map<string, ScheduledUpload>();
  readonly #active = new Map<string, AbortController>();

  has(key: string): boolean {
    return this.#pending.has(key) || this.#active.has(key);
  }

  enqueue(upload: ScheduledUpload): boolean {
    if (this.has(upload.key)) return false;
    this.#pending.set(upload.key, upload);
    this.#drain();
    return true;
  }

  cancel(key: string): void {
    this.#pending.delete(key);
    this.#active.get(key)?.abort();
  }

  #drain(): void {
    while (this.#active.size < MAX_ACTIVE_UPLOADS) {
      const next = this.#pending.values().next().value;
      if (!next) return;
      this.#pending.delete(next.key);
      const controller = new AbortController();
      this.#active.set(next.key, controller);
      void next
        .run(controller.signal)
        .then(
          () => next.settled(null, controller.signal.aborted),
          (error: unknown) => next.settled(error, controller.signal.aborted),
        )
        .catch(() => undefined)
        .finally(() => {
          if (this.#active.get(next.key) === controller) this.#active.delete(next.key);
          this.#drain();
        });
    }
  }
}
