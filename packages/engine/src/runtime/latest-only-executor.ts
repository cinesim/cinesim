export interface LatestOnlyContext {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface LatestOnlyMetrics {
  received: number;
  coalesced: number;
  completed: number;
  obsolete: number;
  failed: number;
  inFlight: number;
  pending: number;
}

interface Request<TInput, TOutput> {
  generation: number;
  input: TInput;
  resolve: (value: TOutput | undefined) => void;
  reject: (reason: unknown) => void;
}

/** Runs one operation at a time and retains only the newest pending request. */
export class LatestOnlyExecutor<TInput, TOutput> {
  #generation = 0;
  #running = false;
  #destroyed = false;
  #pending: Request<TInput, TOutput> | null = null;
  readonly #worker: (input: TInput, context: LatestOnlyContext) => Promise<TOutput>;
  readonly #metrics: LatestOnlyMetrics = {
    received: 0,
    coalesced: 0,
    completed: 0,
    obsolete: 0,
    failed: 0,
    inFlight: 0,
    pending: 0,
  };

  constructor(worker: (input: TInput, context: LatestOnlyContext) => Promise<TOutput>) {
    this.#worker = worker;
  }

  run(input: TInput): Promise<TOutput | undefined> {
    if (this.#destroyed) return Promise.resolve(undefined);
    this.#metrics.received += 1;
    const generation = ++this.#generation;
    return new Promise<TOutput | undefined>((resolve, reject) => {
      const request = { generation, input, resolve, reject };
      if (this.#running) {
        if (this.#pending) {
          this.#metrics.coalesced += 1;
          this.#pending.resolve(undefined);
        }
        this.#pending = request;
        this.#metrics.pending = 1;
        return;
      }
      void this.#drain(request);
    });
  }

  invalidate(): void {
    this.#generation += 1;
    if (this.#pending) {
      this.#pending.resolve(undefined);
      this.#pending = null;
      this.#metrics.pending = 0;
      this.#metrics.coalesced += 1;
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.invalidate();
  }

  get metrics(): Readonly<LatestOnlyMetrics> {
    return { ...this.#metrics };
  }

  async #drain(first: Request<TInput, TOutput>): Promise<void> {
    this.#running = true;
    let request: Request<TInput, TOutput> | null = first;
    while (request) {
      this.#metrics.inFlight = 1;
      const context: LatestOnlyContext = {
        generation: request.generation,
        isCurrent: () => !this.#destroyed && request?.generation === this.#generation,
      };
      try {
        const output = await this.#worker(request.input, context);
        if (context.isCurrent()) {
          this.#metrics.completed += 1;
          request.resolve(output);
        } else {
          this.#metrics.obsolete += 1;
          request.resolve(undefined);
        }
      } catch (error) {
        this.#metrics.failed += 1;
        request.reject(error);
      }
      request = this.#pending;
      this.#pending = null;
      this.#metrics.pending = 0;
    }
    this.#metrics.inFlight = 0;
    this.#running = false;
  }
}
