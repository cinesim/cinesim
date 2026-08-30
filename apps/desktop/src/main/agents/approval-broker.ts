export interface AgentApprovalLease {
  requestId: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  detail: string;
  expiresAt: number;
}

interface PendingApproval extends AgentApprovalLease {
  timer: NodeJS.Timeout;
  resolve(accepted: boolean): void;
  expired(lease: AgentApprovalLease): void;
}

export class AgentApprovalBroker {
  readonly #pending = new Map<string, PendingApproval>();

  constructor(private readonly leaseMilliseconds: number) {}

  request(input: {
    sessionId: string;
    turnId: string;
    toolName: string;
    detail: string;
    expired(lease: AgentApprovalLease): void;
  }): { lease: AgentApprovalLease; decision: Promise<boolean> } {
    const lease: AgentApprovalLease = {
      requestId: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.toolName,
      detail: input.detail,
      expiresAt: Date.now() + this.leaseMilliseconds,
    };
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.expire(lease.requestId), this.leaseMilliseconds);
      this.#pending.set(lease.requestId, {
        ...lease,
        timer,
        resolve,
        expired: (expiredLease) => input.expired(expiredLease),
      });
    });
    return { lease, decision };
  }

  intent(
    sessionId: string,
    requestId: string,
    activeTurnId: string | undefined,
  ): AgentApprovalLease {
    const pending = this.#pending.get(requestId);
    if (
      !pending ||
      pending.sessionId !== sessionId ||
      pending.turnId !== activeTurnId ||
      Date.now() >= pending.expiresAt
    ) {
      if (pending) this.expire(requestId);
      throw new Error("Approval request is no longer active");
    }
    return pending;
  }

  resolve(input: {
    sessionId: string;
    requestId: string;
    activeTurnId: string | undefined;
    accepted: boolean;
  }): AgentApprovalLease {
    const lease = this.intent(input.sessionId, input.requestId, input.activeTurnId);
    const pending = this.#take(input.requestId)!;
    pending.resolve(input.accepted);
    return lease;
  }

  expire(requestId: string): AgentApprovalLease | null {
    const pending = this.#take(requestId);
    if (!pending) return null;
    pending.resolve(false);
    pending.expired(pending);
    return pending;
  }

  cancelSession(sessionId: string): AgentApprovalLease[] {
    const canceled: AgentApprovalLease[] = [];
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) continue;
      this.#take(requestId);
      pending.resolve(false);
      canceled.push(pending);
    }
    return canceled;
  }

  #take(requestId: string): PendingApproval | null {
    const pending = this.#pending.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    return pending;
  }
}
