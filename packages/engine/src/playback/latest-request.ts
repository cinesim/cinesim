export class LatestRequestController<TInput, TOutput> {
  #generation = 0;
  readonly #worker: (input: TInput) => Promise<TOutput>;

  constructor(worker: (input: TInput) => Promise<TOutput>) {
    this.#worker = worker;
  }

  async run(input: TInput): Promise<TOutput | undefined> {
    const generation = ++this.#generation;
    const output = await this.#worker(input);
    return generation === this.#generation ? output : undefined;
  }

  invalidate(): void {
    this.#generation += 1;
  }
}
