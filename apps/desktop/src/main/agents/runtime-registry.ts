import type { AgentProviderRuntime } from "./runtimes/types";

export class AgentRuntimeRegistry {
  readonly #runtimes = new Map<string, AgentProviderRuntime>();

  get(sessionId: string): AgentProviderRuntime | undefined {
    return this.#runtimes.get(sessionId);
  }

  set(sessionId: string, runtime: AgentProviderRuntime): void {
    this.#runtimes.set(sessionId, runtime);
  }

  remove(sessionId: string): boolean {
    return this.#runtimes.delete(sessionId);
  }

  sessionIds(): string[] {
    return [...this.#runtimes.keys()];
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.#runtimes.get(sessionId);
    if (runtime) await runtime.stop();
    this.#runtimes.delete(sessionId);
  }
}
