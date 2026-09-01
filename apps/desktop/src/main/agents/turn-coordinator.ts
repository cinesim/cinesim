import type { AgentCheckpoint, AgentSessionSnapshot } from "../../shared/contracts";
import { AgentCheckpointStore } from "./checkpoints";

function timestamp(): string {
  return new Date().toISOString();
}

export class AgentTurnCoordinator {
  readonly #stores = new Map<string, AgentCheckpointStore>();

  async captureBefore(session: AgentSessionSnapshot, turnNumber: number): Promise<void> {
    const store = this.#store(session.projectDirectory);
    await store.capture(store.ref(session.id, turnNumber, "before"));
  }

  async complete(
    session: AgentSessionSnapshot,
    turnId: string,
    turnNumber: number,
  ): Promise<AgentCheckpoint> {
    const store = this.#store(session.projectDirectory);
    const beforeRef = store.ref(session.id, turnNumber, "before");
    const afterRef = store.ref(session.id, turnNumber, "after");
    await store.capture(afterRef);
    return {
      turnId,
      turnNumber,
      beforeRef,
      afterRef,
      summary: await store.diffSummary(beforeRef, afterRef),
      createdAt: timestamp(),
    };
  }

  removeProject(projectDirectory: string): void {
    this.#stores.delete(projectDirectory);
  }

  #store(projectDirectory: string): AgentCheckpointStore {
    let store = this.#stores.get(projectDirectory);
    if (!store) {
      store = new AgentCheckpointStore(projectDirectory);
      this.#stores.set(projectDirectory, store);
    }
    return store;
  }
}
