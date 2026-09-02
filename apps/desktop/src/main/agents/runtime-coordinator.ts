import type { AgentSessionSnapshot, AgentTokenUsage } from "../../shared/contracts";
import type { AgentMcpServer } from "./mcp/server";
import { createAgentRuntime } from "./runtimes/factory";
import type { AgentRuntimeEvent } from "./runtimes/types";
import { AgentRuntimeRegistry } from "./runtime-registry";
import type { AgentSettingsStore } from "./settings-store";

interface AgentRuntimeHost {
  event(sessionId: string, event: AgentRuntimeEvent): void;
  providerSessionId(sessionId: string, providerSessionId: string): void;
  turnStarted(sessionId: string, providerTurnId?: string): void;
  turnCompleted(
    sessionId: string,
    status: "completed" | "failed" | "interrupted",
    detail?: string,
  ): void;
  tokenUsage(sessionId: string, usage: Omit<AgentTokenUsage, "updatedAt">): void;
  exited(sessionId: string, detail?: string): void;
}

export class AgentRuntimeCoordinator {
  readonly #runtimes = new AgentRuntimeRegistry();

  constructor(
    private readonly settings: AgentSettingsStore,
    private readonly mcpServer: AgentMcpServer,
    private readonly host: AgentRuntimeHost,
  ) {}

  async send(session: AgentSessionSnapshot, message: string): Promise<void> {
    const runtime = await this.#ensure(session);
    await runtime.send(message);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.#runtimes.get(sessionId)?.interrupt();
  }

  async stop(sessionId: string): Promise<void> {
    await this.#runtimes.stop(sessionId);
    this.mcpServer.revokeSession(sessionId);
  }

  async close(): Promise<void> {
    for (const sessionId of this.#runtimes.sessionIds()) await this.stop(sessionId);
  }

  sessionIds(): string[] {
    return this.#runtimes.sessionIds();
  }

  async #ensure(session: AgentSessionSnapshot) {
    const existing = this.#runtimes.get(session.id);
    if (existing) return existing;

    const executablePath = await this.settings.requireTrustedExecutable(session.provider);
    const credential = this.mcpServer.registerSession({
      sessionId: session.id,
      projectDirectory: session.projectDirectory,
    });
    const runtime = createAgentRuntime(
      session.provider,
      {
        executablePath,
        cwd: session.projectDirectory,
        model: session.model,
        effort: session.effort,
        ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
        mcpUrl: credential.url,
        mcpToken: credential.token,
      },
      {
        onEvent: (event) => this.host.event(session.id, event),
        onProviderSessionId: (providerSessionId) =>
          this.host.providerSessionId(session.id, providerSessionId),
        onTurnStarted: (providerTurnId) => this.host.turnStarted(session.id, providerTurnId),
        onTurnCompleted: (status, detail) => this.host.turnCompleted(session.id, status, detail),
        onTokenUsage: (usage) => this.host.tokenUsage(session.id, usage),
        onExit: (detail) => this.#providerExited(session.id, detail),
      },
    );
    this.#runtimes.set(session.id, runtime);
    try {
      await runtime.start();
      return runtime;
    } catch (error) {
      this.#runtimes.remove(session.id);
      this.mcpServer.revokeSession(session.id);
      throw error;
    }
  }

  #providerExited(sessionId: string, detail?: string): void {
    if (!this.#runtimes.remove(sessionId)) return;
    this.mcpServer.revokeSession(sessionId);
    this.host.exited(sessionId, detail);
  }
}
