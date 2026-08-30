import type {
  AgentCheckpoint,
  AgentCreateInput,
  AgentEvent,
  AgentProjectSnapshot,
  AgentSessionSnapshot,
  AgentSessionUpdate,
  AgentTokenUsage,
  AgentTurnContext,
} from "../../shared/api";
import { AgentCheckpointStore } from "./checkpoints";
import { AgentMcpServer, type AgentToolHooks } from "./mcp/server";
import type { AgentProviderRuntime, AgentRuntimeEvent } from "./runtimes/types";
import { createAgentRuntime } from "./runtimes/factory";
import { AgentSessionStore } from "./session-store";
import type { AgentSettingsStore } from "./settings-store";
import type { DesktopProjectStore } from "../projects/project-store";

interface PersistedAgentState {
  version: 1;
  activeSessionByProject: Record<string, string>;
  sessions: AgentSessionSnapshot[];
}

interface PendingApproval {
  sessionId: string;
  turnId: string;
  toolName: string;
  detail: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  resolve(accepted: boolean): void;
}

const EMPTY_STATE: PersistedAgentState = {
  version: 1,
  activeSessionByProject: {},
  sessions: [],
};

const MAX_EVENTS_PER_SESSION = 600;
const APPROVAL_LEASE_MS = 2 * 60 * 1_000;

function now(): string {
  return new Date().toISOString();
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromMessage(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.length > 46 ? `${normalized.slice(0, 45)}…` : normalized;
}

function isSession(value: unknown): value is AgentSessionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === "string" &&
    typeof session.projectDirectory === "string" &&
    (session.provider === "claude" || session.provider === "codex") &&
    typeof session.title === "string" &&
    Array.isArray(session.events) &&
    Array.isArray(session.checkpoints)
  );
}

export class AgentManager implements AgentToolHooks {
  #state: PersistedAgentState = structuredClone(EMPTY_STATE);
  #runtimes = new Map<string, AgentProviderRuntime>();
  #pendingApprovals = new Map<string, PendingApproval>();
  #checkpointStores = new Map<string, AgentCheckpointStore>();
  #saveTimer: NodeJS.Timeout | null = null;
  #sessionStore: AgentSessionStore;
  readonly mcpServer: AgentMcpServer;

  constructor(
    path: string,
    private readonly settingsStore: AgentSettingsStore,
    private readonly projectStore: DesktopProjectStore,
    private readonly onChanged: (snapshot: AgentProjectSnapshot) => void,
    private readonly notifyProjectChanged: () => void,
  ) {
    this.#sessionStore = new AgentSessionStore(path);
    this.mcpServer = new AgentMcpServer(projectStore, this);
  }

  async load(): Promise<void> {
    try {
      const candidate = await this.#sessionStore.read();
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
        throw new Error("Invalid agent state");
      const record = candidate as Record<string, unknown>;
      const sessions = Array.isArray(record.sessions) ? record.sessions.filter(isSession) : [];
      for (const session of sessions) {
        if (!(["low", "medium", "high", "xhigh", "max"] as const).includes(session.effort))
          session.effort = this.settingsStore.snapshot().providers[session.provider].effort;
        const resolvedApprovals = new Set(
          session.events
            .filter((event) => event.kind === "approval-resolved")
            .map((event) => event.requestId),
        );
        for (const request of session.events.filter(
          (event) =>
            event.kind === "approval-requested" &&
            event.requestId &&
            !resolvedApprovals.has(event.requestId),
        )) {
          const requestId = request.requestId;
          if (!requestId) continue;
          session.events.push({
            id: crypto.randomUUID(),
            sessionId: session.id,
            kind: "approval-resolved",
            createdAt: now(),
            requestId,
            title: "Cancelled",
            status: "declined",
          });
        }
        if (
          session.status === "working" ||
          session.status === "starting" ||
          session.status === "waiting"
        ) {
          session.status = "interrupted";
          session.activeTurnId = undefined;
          session.events.push({
            id: crypto.randomUUID(),
            sessionId: session.id,
            kind: "notice",
            createdAt: now(),
            title: "Session interrupted",
            detail:
              "Cinesim restarted while this agent was running. Send another message to resume.",
          });
        }
      }
      this.#state = {
        version: 1,
        sessions,
        activeSessionByProject:
          typeof record.activeSessionByProject === "object" &&
          record.activeSessionByProject !== null &&
          !Array.isArray(record.activeSessionByProject)
            ? (record.activeSessionByProject as Record<string, string>)
            : {},
      };
    } catch {
      this.#state = structuredClone(EMPTY_STATE);
    }
    await this.mcpServer.start();
    this.#scheduleSave();
  }

  snapshot(projectDirectory: string): AgentProjectSnapshot {
    const sessions = this.#state.sessions
      .filter((session) => session.projectDirectory === projectDirectory)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const preferred = this.#state.activeSessionByProject[projectDirectory];
    const activeSessionId = sessions.some((session) => session.id === preferred)
      ? (preferred ?? null)
      : (sessions[0]?.id ?? null);
    return { projectDirectory, activeSessionId, sessions: structuredClone(sessions) };
  }

  async create(input: AgentCreateInput): Promise<AgentProjectSnapshot> {
    this.#requireOpenProject(input.projectDirectory);
    const settings = this.settingsStore.snapshot().providers[input.provider];
    const timestamp = now();
    const session: AgentSessionSnapshot = {
      id: crypto.randomUUID(),
      projectDirectory: input.projectDirectory,
      provider: input.provider,
      model: input.model?.trim() || settings.model,
      effort: input.effort ?? settings.effort,
      permissionMode: input.permissionMode ?? settings.permissionMode,
      title: `New ${input.provider === "claude" ? "Claude" : "Codex"} agent`,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [],
      checkpoints: [],
    };
    this.#state.sessions.push(session);
    this.#state.activeSessionByProject[input.projectDirectory] = session.id;
    return this.#changed(input.projectDirectory);
  }

  async ensure(input: AgentCreateInput): Promise<AgentProjectSnapshot> {
    this.#requireOpenProject(input.projectDirectory);
    const existing = this.#state.sessions.find(
      (session) => session.projectDirectory === input.projectDirectory,
    );
    if (!existing) return this.create(input);
    this.#state.activeSessionByProject[input.projectDirectory] = existing.id;
    return this.#changed(input.projectDirectory);
  }

  async select(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    if (session.projectDirectory !== projectDirectory)
      throw new Error("Agent is not in this project");
    this.#state.activeSessionByProject[projectDirectory] = sessionId;
    return this.#changed(projectDirectory);
  }

  async update(sessionId: string, input: AgentSessionUpdate): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    if (
      session.status === "starting" ||
      session.status === "working" ||
      session.status === "waiting"
    )
      throw new Error("Stop this agent before changing its model or approval mode");
    const model = input.model?.trim();
    const nextModel = model || session.model;
    const nextEffort = input.effort ?? session.effort;
    const nextPermissionMode = input.permissionMode ?? session.permissionMode;
    if (
      nextModel !== session.model ||
      nextEffort !== session.effort ||
      nextPermissionMode !== session.permissionMode
    ) {
      await this.#stopRuntime(sessionId);
      if (nextModel !== session.model) session.tokenUsage = undefined;
      session.model = nextModel;
      session.effort = nextEffort;
      session.permissionMode = nextPermissionMode;
      session.updatedAt = now();
    }
    return this.#changed(session.projectDirectory);
  }

  async delete(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    if (session.projectDirectory !== projectDirectory)
      throw new Error("Agent is not in this project");
    await this.#stopRuntime(sessionId);
    this.#state.sessions = this.#state.sessions.filter((candidate) => candidate.id !== sessionId);
    if (this.#state.activeSessionByProject[projectDirectory] === sessionId)
      delete this.#state.activeSessionByProject[projectDirectory];
    return this.#changed(projectDirectory);
  }

  async removeProject(projectDirectory: string): Promise<void> {
    const sessionIds = this.#state.sessions
      .filter((session) => session.projectDirectory === projectDirectory)
      .map((session) => session.id);
    await Promise.all(sessionIds.map((sessionId) => this.#stopRuntime(sessionId)));
    this.#state.sessions = this.#state.sessions.filter(
      (session) => session.projectDirectory !== projectDirectory,
    );
    delete this.#state.activeSessionByProject[projectDirectory];
    this.#checkpointStores.delete(projectDirectory);
    await this.#save();
    this.onChanged({ projectDirectory, activeSessionId: null, sessions: [] });
  }

  async stopProject(projectDirectory: string): Promise<void> {
    const sessionIds = this.#state.sessions
      .filter((session) => session.projectDirectory === projectDirectory)
      .map((session) => session.id);
    await Promise.all(sessionIds.map((sessionId) => this.#stopRuntime(sessionId)));
  }

  async send(
    sessionId: string,
    rawMessage: string,
    context: AgentTurnContext = {},
  ): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    this.#requireOpenProject(session.projectDirectory);
    const message = rawMessage.trim();
    if (!message || message.length > 100_000) throw new Error("Message is empty or too long");
    const conflicting = this.#state.sessions.find(
      (candidate) =>
        candidate.id !== session.id &&
        candidate.projectDirectory === session.projectDirectory &&
        (candidate.status === "starting" ||
          candidate.status === "working" ||
          candidate.status === "waiting"),
    );
    if (conflicting) throw new Error(`“${conflicting.title}” is already editing this project`);
    if (
      session.status === "starting" ||
      session.status === "working" ||
      session.status === "waiting"
    )
      throw new Error("This agent is already working");

    const turnId = crypto.randomUUID();
    const turnNumber = session.checkpoints.length + 1;
    session.activeTurnId = turnId;
    session.status = "starting";
    session.updatedAt = now();
    if (session.events.length === 0) session.title = titleFromMessage(message);
    this.#appendEvent(session, { kind: "user-message", text: message, turnId });
    this.#changed(session.projectDirectory);

    const checkpoints = this.#checkpointStore(session.projectDirectory);
    const beforeRef = checkpoints.ref(session.id, turnNumber, "before");
    try {
      await checkpoints.capture(beforeRef);
      const runtime = await this.#ensureRuntime(session);
      const contextLines = [
        `Project revision: ${this.projectStore.session().revision}`,
        context.activeSequenceId ? `Active sequence: ${context.activeSequenceId}` : "",
        context.playheadUs === undefined ? "" : `Playhead: ${context.playheadUs} microseconds`,
        context.selectedIds?.length ? `Selected IDs: ${context.selectedIds.join(", ")}` : "",
      ].filter(Boolean);
      await runtime.send(`${contextLines.join("\n")}\n\nUser request:\n${message}`);
    } catch (error) {
      session.status = "failed";
      session.activeTurnId = undefined;
      session.updatedAt = now();
      this.#appendEvent(session, {
        kind: "error",
        title: "Could not start agent",
        detail: messageFrom(error),
        turnId,
      });
      this.#changed(session.projectDirectory);
    }
    return this.snapshot(session.projectDirectory);
  }

  async interrupt(sessionId: string): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    await this.#runtimes.get(sessionId)?.interrupt();
    this.#cancelPendingApprovals(sessionId);
    if (session.activeTurnId)
      await this.#completeTurn(sessionId, "interrupted", "The agent was stopped by the user.");
    return this.snapshot(session.projectDirectory);
  }

  async respondApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "decline",
  ): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    const pending = this.#pendingApprovals.get(requestId);
    if (!pending || pending.sessionId !== sessionId)
      throw new Error("Approval request is no longer active");
    if (pending.turnId !== session.activeTurnId || Date.now() >= pending.expiresAt) {
      this.#expireApproval(requestId);
      throw new Error("Approval request expired");
    }
    this.#pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision === "accept");
    session.status = "working";
    this.#appendEvent(session, {
      kind: "approval-resolved",
      requestId,
      title: decision === "accept" ? "Approved" : "Declined",
      status: decision === "accept" ? "completed" : "declined",
    });
    return this.#changed(session.projectDirectory);
  }

  approvalIntent(sessionId: string, requestId: string): { toolName: string; detail: string } {
    const session = this.#requireSession(sessionId);
    const pending = this.#pendingApprovals.get(requestId);
    if (
      !pending ||
      pending.sessionId !== sessionId ||
      pending.turnId !== session.activeTurnId ||
      Date.now() >= pending.expiresAt
    ) {
      if (pending) this.#expireApproval(requestId);
      throw new Error("Approval request is no longer active");
    }
    return { toolName: pending.toolName, detail: pending.detail };
  }

  revertIntent(sessionId: string, turnId: string): { turnNumber: number; summary: string } {
    const session = this.#requireSession(sessionId);
    const checkpoint = session.checkpoints.find((candidate) => candidate.turnId === turnId);
    if (!checkpoint) throw new Error("Checkpoint is unavailable for this turn");
    return { turnNumber: checkpoint.turnNumber, summary: checkpoint.summary };
  }

  async revert(sessionId: string, turnId: string): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    const checkpoint = session.checkpoints.find((candidate) => candidate.turnId === turnId);
    if (!checkpoint) throw new Error("Checkpoint is unavailable for this turn");
    await this.#stopRuntime(sessionId);
    await this.#checkpointStore(session.projectDirectory).restore(checkpoint.beforeRef);
    await this.projectStore.open(session.projectDirectory);
    session.providerSessionId = undefined;
    session.tokenUsage = undefined;
    session.activeTurnId = undefined;
    session.status = "completed";
    session.updatedAt = now();
    this.#appendEvent(session, {
      kind: "notice",
      title: "Turn reverted",
      detail: `Restored the project to before turn ${checkpoint.turnNumber}. The next message starts a fresh provider context.`,
    });
    this.notifyProjectChanged();
    return this.#changed(session.projectDirectory);
  }

  async close(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    for (const sessionId of this.#runtimes.keys()) await this.#stopRuntime(sessionId);
    await this.mcpServer.close();
    await this.#save();
  }

  async onToolStarted(sessionId: string, toolName: string, detail: string): Promise<string> {
    const session = this.#requireSession(sessionId);
    const event = this.#appendEvent(session, {
      kind: "tool-started",
      toolName,
      title: toolName.replaceAll("_", " "),
      detail,
      status: "running",
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    });
    this.#changed(session.projectDirectory);
    return event.id;
  }

  async onToolCompleted(
    sessionId: string,
    eventId: string,
    toolName: string,
    detail: string,
    failed = false,
  ): Promise<void> {
    const session = this.#requireSession(sessionId);
    const started = session.events.find((event) => event.id === eventId);
    if (started) {
      started.kind = "tool-completed";
      started.status = failed ? "failed" : "completed";
      started.detail = detail;
      started.createdAt = now();
    } else {
      this.#appendEvent(session, {
        kind: "tool-completed",
        toolName,
        title: toolName.replaceAll("_", " "),
        detail,
        status: failed ? "failed" : "completed",
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      });
    }
    this.#changed(session.projectDirectory);
  }

  requestApproval(sessionId: string, toolName: string, detail: string): Promise<boolean> {
    const session = this.#requireSession(sessionId);
    if (!session.activeTurnId) throw new Error("Approval requires an active agent turn");
    const requestId = crypto.randomUUID();
    const turnId = session.activeTurnId;
    session.status = "waiting";
    this.#appendEvent(session, {
      kind: "approval-requested",
      requestId,
      title: `Allow ${toolName.replaceAll("_", " ")}?`,
      detail,
      destructive: true,
      status: "running",
      turnId,
    });
    this.#changed(session.projectDirectory);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.#expireApproval(requestId), APPROVAL_LEASE_MS);
      this.#pendingApprovals.set(requestId, {
        sessionId,
        turnId,
        toolName,
        detail,
        expiresAt: Date.now() + APPROVAL_LEASE_MS,
        timer,
        resolve,
      });
    });
  }

  onProjectChanged(): void {
    this.notifyProjectChanged();
  }

  async #ensureRuntime(session: AgentSessionSnapshot): Promise<AgentProviderRuntime> {
    const existing = this.#runtimes.get(session.id);
    if (existing) return existing;
    const executablePath = await this.settingsStore.requireTrustedExecutable(session.provider);
    const credential = this.mcpServer.registerSession({
      sessionId: session.id,
      projectDirectory: session.projectDirectory,
      permissionMode: session.permissionMode,
    });
    const callbacks = {
      onEvent: (event: AgentRuntimeEvent) => this.#runtimeEvent(session.id, event),
      onProviderSessionId: (providerSessionId: string) => {
        session.providerSessionId = providerSessionId;
        session.updatedAt = now();
        this.#changed(session.projectDirectory);
      },
      onTurnStarted: (providerTurnId?: string) => {
        session.status = "working";
        if (providerTurnId && !session.activeTurnId) session.activeTurnId = providerTurnId;
        session.updatedAt = now();
        this.#changed(session.projectDirectory);
      },
      onTurnCompleted: (status: "completed" | "failed" | "interrupted", detail?: string) =>
        void this.#completeTurn(session.id, status, detail),
      onTokenUsage: (usage: Omit<AgentTokenUsage, "updatedAt">) => {
        session.tokenUsage = { ...usage, updatedAt: now() };
        session.updatedAt = now();
        this.#changed(session.projectDirectory);
      },
      onApproval: (title: string, detail: string) =>
        this.requestApproval(session.id, title, detail),
      onExit: (detail?: string) => void this.#providerExited(session.id, detail),
    };
    const launchOptions = {
      executablePath,
      cwd: session.projectDirectory,
      model: session.model,
      effort: session.effort,
      ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      mcpUrl: credential.url,
      mcpToken: credential.token,
      instructions: this.#instructions(),
    };
    const runtime = createAgentRuntime(session.provider, launchOptions, callbacks);
    this.#runtimes.set(session.id, runtime);
    try {
      await runtime.start();
      return runtime;
    } catch (error) {
      this.#runtimes.delete(session.id);
      this.mcpServer.revokeSession(session.id);
      throw error;
    }
  }

  #runtimeEvent(sessionId: string, event: AgentRuntimeEvent): void {
    const session = this.#requireSession(sessionId);
    const last = session.events.at(-1);
    if (
      event.text &&
      (event.kind === "assistant-message" || event.kind === "reasoning") &&
      last?.kind === event.kind &&
      last.turnId === session.activeTurnId
    ) {
      last.text = `${last.text ?? ""}${event.text}`;
      last.createdAt = now();
    } else {
      this.#appendEvent(session, {
        ...event,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      });
    }
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
  }

  async #completeTurn(
    sessionId: string,
    status: "completed" | "failed" | "interrupted",
    detail?: string,
  ): Promise<void> {
    const session = this.#requireSession(sessionId);
    const turnId = session.activeTurnId;
    if (!turnId) return;
    const turnNumber = session.checkpoints.length + 1;
    const checkpointStore = this.#checkpointStore(session.projectDirectory);
    const beforeRef = checkpointStore.ref(session.id, turnNumber, "before");
    const afterRef = checkpointStore.ref(session.id, turnNumber, "after");
    try {
      await checkpointStore.capture(afterRef);
      const summary = await checkpointStore.diffSummary(beforeRef, afterRef);
      const checkpoint: AgentCheckpoint = {
        turnId,
        turnNumber,
        beforeRef,
        afterRef,
        summary,
        createdAt: now(),
      };
      session.checkpoints.push(checkpoint);
      this.#appendEvent(session, {
        kind: "checkpoint",
        title:
          summary === "No canonical project changes" ? "No project changes" : "Turn checkpoint",
        detail: summary,
        turnId,
        status: "completed",
      });
    } catch (error) {
      this.#appendEvent(session, {
        kind: "error",
        title: "Checkpoint failed",
        detail: messageFrom(error),
        turnId,
      });
    }
    if (detail)
      this.#appendEvent(session, {
        kind: status === "failed" ? "error" : "notice",
        title: status === "failed" ? "Turn failed" : "Turn interrupted",
        detail,
        turnId,
      });
    session.status = status === "completed" ? "completed" : status;
    session.activeTurnId = undefined;
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
  }

  async #stopRuntime(sessionId: string): Promise<void> {
    const runtime = this.#runtimes.get(sessionId);
    if (runtime) await runtime.stop();
    this.#runtimes.delete(sessionId);
    this.mcpServer.revokeSession(sessionId);
    this.#cancelPendingApprovals(sessionId);
  }

  async #providerExited(sessionId: string, detail?: string): Promise<void> {
    const wasRegistered = this.#runtimes.delete(sessionId);
    if (!wasRegistered) return;
    this.mcpServer.revokeSession(sessionId);
    this.#cancelPendingApprovals(sessionId);
    const session = this.#state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    if (session.activeTurnId) {
      await this.#completeTurn(
        sessionId,
        detail ? "failed" : "interrupted",
        detail ?? "The provider stopped before completing the turn.",
      );
    }
  }

  #cancelPendingApprovals(sessionId: string): void {
    const session = this.#state.sessions.find((candidate) => candidate.id === sessionId);
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.#pendingApprovals.delete(requestId);
        if (session)
          this.#appendEvent(session, {
            kind: "approval-resolved",
            requestId,
            title: "Cancelled",
            status: "declined",
            ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
          });
      }
    }
  }

  #expireApproval(requestId: string): void {
    const pending = this.#pendingApprovals.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingApprovals.delete(requestId);
    pending.resolve(false);
    const session = this.#state.sessions.find((candidate) => candidate.id === pending.sessionId);
    if (!session) return;
    session.status = session.activeTurnId === pending.turnId ? "working" : session.status;
    this.#appendEvent(session, {
      kind: "approval-resolved",
      requestId,
      title: "Approval expired",
      status: "declined",
      turnId: pending.turnId,
    });
    this.#changed(session.projectDirectory);
  }

  #appendEvent(
    session: AgentSessionSnapshot,
    input: Omit<AgentEvent, "id" | "sessionId" | "createdAt">,
  ): AgentEvent {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      createdAt: now(),
      ...input,
    };
    session.events.push(event);
    if (session.events.length > MAX_EVENTS_PER_SESSION)
      session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
    return event;
  }

  #requireOpenProject(projectDirectory: string): void {
    if (this.projectStore.directory !== projectDirectory || !this.projectStore.project)
      throw new Error("Open this agent's Cinesim project before continuing");
  }

  #requireSession(sessionId: string): AgentSessionSnapshot {
    const session = this.#state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Agent session not found");
    return session;
  }

  #checkpointStore(projectDirectory: string): AgentCheckpointStore {
    let store = this.#checkpointStores.get(projectDirectory);
    if (!store) {
      store = new AgentCheckpointStore(projectDirectory);
      this.#checkpointStores.set(projectDirectory, store);
    }
    return store;
  }

  #changed(projectDirectory: string): AgentProjectSnapshot {
    const snapshot = this.snapshot(projectDirectory);
    this.onChanged(snapshot);
    this.#scheduleSave();
    return snapshot;
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#save();
    }, 150);
  }

  async #save(): Promise<void> {
    await this.#sessionStore.write(this.#state);
  }

  #instructions(): string {
    return `You are working inside Cinesim, a local-first nonlinear video editor.

Use the cinesim MCP tools for every canonical project edit. Never write cinesim.json or files under .cinesim directly. Inspect the current project and timeline before editing. All timeline times are integer microseconds and all entities are addressed by stable IDs. Source media is referenced in place and must never be moved, overwritten, or deleted. Files under .video are derived and disposable. Explain completed changes clearly and mention the stable IDs you changed.`;
  }
}
