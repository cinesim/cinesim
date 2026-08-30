export class AgentStreamBatcher {
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly intervalMilliseconds: number) {}

  schedule(projectDirectory: string, publish: () => void): void {
    if (this.#timers.has(projectDirectory)) return;
    this.#timers.set(
      projectDirectory,
      setTimeout(() => {
        this.#timers.delete(projectDirectory);
        publish();
      }, this.intervalMilliseconds),
    );
  }

  cancel(projectDirectory: string): void {
    const timer = this.#timers.get(projectDirectory);
    if (timer) clearTimeout(timer);
    this.#timers.delete(projectDirectory);
  }

  clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
