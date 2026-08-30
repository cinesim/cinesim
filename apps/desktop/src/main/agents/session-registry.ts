import type { AgentSessionSnapshot } from "../../shared/contracts";
import type { PersistedAgentState } from "./session-store";

const EMPTY_STATE: PersistedAgentState = {
  version: 1,
  activeSessionByProject: {},
  sessions: [],
};

export class AgentSessionRegistry {
  #state: PersistedAgentState = structuredClone(EMPTY_STATE);

  get state(): PersistedAgentState {
    return this.#state;
  }

  replace(state: PersistedAgentState): void {
    this.#state = state;
  }

  reset(): void {
    this.#state = structuredClone(EMPTY_STATE);
  }

  require(sessionId: string): AgentSessionSnapshot {
    const session = this.#state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Agent session not found");
    return session;
  }

  projectSessions(projectDirectory: string): AgentSessionSnapshot[] {
    return this.#state.sessions.filter((session) => session.projectDirectory === projectDirectory);
  }
}
