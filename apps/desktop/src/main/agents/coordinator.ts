import type {
  AgentCreateInput,
  AgentEvent,
  AgentProjectDelta,
  AgentProjectSnapshot,
  AgentSessionSnapshot,
  AgentSessionUpdate,
  AgentTokenUsage,
  AgentTurnContext,
} from "../../shared/contracts";
import { AgentMcpServer, type AgentToolHooks } from "./mcp/server";
import type { AgentRuntimeEvent } from "./runtimes/types";
import { AgentSessionStore } from "./session-store";
import { AgentSessionRegistry } from "./session-registry";
import type { AgentSettingsStore } from "./settings-store";
import type { DesktopProjectStore } from "../projects/project-store";
import { AgentEventPublisher } from "./event-publisher";
import { AgentApprovalBroker } from "./approval-broker";
import type { AgentApprovalLease } from "./approval-broker";
import { AgentStreamBatcher } from "./stream-batcher";
import { AgentTurnCoordinator } from "./turn-coordinator";
import { AgentSessionEvents, boundedAgentText } from "./session-events";
import { isAgentSessionBusy, recoverAgentSession } from "./session-recovery";
import { AgentRuntimeCoordinator } from "./runtime-coordinator";

const APPROVAL_LEASE_MS = 2 * 60 * 1_000;
const STREAM_PUBLICATION_INTERVAL_MS = 40;
const PERSISTENCE_INTERVAL_MS = 1_000;
const MAX_APPROVAL_DETAIL_BYTES = 1024 * 1024;

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

export class AgentCoordinator implements AgentToolHooks {
  #sessions = new AgentSessionRegistry();
  #approvals = new AgentApprovalBroker(APPROVAL_LEASE_MS);
  #turns = new AgentTurnCoordinator();
  #saveTimer: NodeJS.Timeout | null = null;
  #streamBatcher = new AgentStreamBatcher(STREAM_PUBLICATION_INTERVAL_MS);
  #sessionEvents = new AgentSessionEvents();
  #sessionStore: AgentSessionStore;
  #events: AgentEventPublisher;
  #runtimeCoordinator: AgentRuntimeCoordinator;
  readonly mcpServer: AgentMcpServer;

  constructor(
    path: string,
    private readonly settingsStore: AgentSettingsStore,
    private readonly projectStore: DesktopProjectStore,
    publishDelta: (delta: AgentProjectDelta) => void,
    private readonly notifyProjectChanged: () => void,
  ) {
    this.#sessionStore = new AgentSessionStore(path);
    this.#events = new AgentEventPublisher(publishDelta);
    this.mcpServer = new AgentMcpServer(projectStore, this);
    this.#runtimeCoordinator = new AgentRuntimeCoordinator(settingsStore, this.mcpServer, {
      event: (sessionId, event) => this.#runtimeEvent(sessionId, event),
      providerSessionId: (sessionId, providerSessionId) =>
        this.#recordProviderSessionId(sessionId, providerSessionId),
      turnStarted: (sessionId, providerTurnId) =>
        this.#recordTurnStarted(sessionId, providerTurnId),
      turnCompleted: (sessionId, status, detail) =>
        void this.#completeTurn(sessionId, status, detail),
      tokenUsage: (sessionId, usage) => this.#recordTokenUsage(sessionId, usage),
      approval: (sessionId, title, detail) => this.requestApproval(sessionId, title, detail),
      exited: (sessionId, detail) => void this.#providerExited(sessionId, detail),
    });
  }

  async load(): Promise<void> {
    try {
      await this.#loadSessions();
    } catch {
      this.#sessions.reset();
    }
    await this.mcpServer.start();
    this.#scheduleSave();
  }

  async #loadSessions(): Promise<void> {
    const stored = await this.#sessionStore.read();
    for (const session of stored.sessions) recoverAgentSession(session, this.#sessionEvents);
    this.#sessions.replace(stored);
  }

  snapshot(projectDirectory: string): AgentProjectSnapshot {
    const snapshot = this.#projectSnapshot(projectDirectory);
    this.#events.seed(snapshot);
    return snapshot;
  }

  #projectSnapshot(projectDirectory: string): AgentProjectSnapshot {
    const sessions = this.#sessions
      .projectSessions(projectDirectory)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const preferred = this.#sessions.state.activeSessionByProject[projectDirectory];
    const activeSessionId = sessions.some((session) => session.id === preferred)
      ? (preferred ?? null)
      : (sessions[0]?.id ?? null);
    return {
      projectDirectory,
      revision: this.#events.revision(projectDirectory),
      activeSessionId,
      sessions: structuredClone(sessions),
    };
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
    this.#sessions.state.sessions.push(session);
    this.#sessions.state.activeSessionByProject[input.projectDirectory] = session.id;
    return this.#changed(input.projectDirectory);
  }

  async ensure(input: AgentCreateInput): Promise<AgentProjectSnapshot> {
    this.#requireOpenProject(input.projectDirectory);
    const existing = this.#sessions.state.sessions.find(
      (session) => session.projectDirectory === input.projectDirectory,
    );
    if (!existing) return this.create(input);
    this.#sessions.state.activeSessionByProject[input.projectDirectory] = existing.id;
    return this.#changed(input.projectDirectory);
  }

  async select(projectDirectory: string, sessionId: string): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    if (session.projectDirectory !== projectDirectory)
      throw new Error("Agent is not in this project");
    this.#sessions.state.activeSessionByProject[projectDirectory] = sessionId;
    return this.#changed(projectDirectory);
  }

  async update(sessionId: string, input: AgentSessionUpdate): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    if (isAgentSessionBusy(session))
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
    this.#sessions.state.sessions = this.#sessions.state.sessions.filter(
      (candidate) => candidate.id !== sessionId,
    );
    this.#sessionEvents.remove(sessionId);
    if (this.#sessions.state.activeSessionByProject[projectDirectory] === sessionId)
      delete this.#sessions.state.activeSessionByProject[projectDirectory];
    return this.#changed(projectDirectory);
  }

  async removeProject(projectDirectory: string): Promise<void> {
    const sessionIds = this.#sessions.state.sessions
      .filter((session) => session.projectDirectory === projectDirectory)
      .map((session) => session.id);
    await Promise.all(sessionIds.map((sessionId) => this.#stopRuntime(sessionId)));
    for (const sessionId of sessionIds) this.#sessionEvents.remove(sessionId);
    this.#sessions.state.sessions = this.#sessions.state.sessions.filter(
      (session) => session.projectDirectory !== projectDirectory,
    );
    delete this.#sessions.state.activeSessionByProject[projectDirectory];
    this.#turns.removeProject(projectDirectory);
    await this.#save();
    this.#changed(projectDirectory);
  }

  async stopProject(projectDirectory: string): Promise<void> {
    const sessionIds = this.#sessions.state.sessions
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
    const message = rawMessage.trim();
    this.#validateMessage(session, message);
    const { turnId, turnNumber } = this.#startTurn(session, message);
    try {
      await this.#turns.captureBefore(session, turnNumber);
      await this.#runtimeCoordinator.send(session, this.#runtimeMessage(message, context));
    } catch (error) {
      this.#failTurnStart(session, turnId, error);
    }
    return this.snapshot(session.projectDirectory);
  }

  #validateMessage(session: AgentSessionSnapshot, message: string): void {
    this.#requireOpenProject(session.projectDirectory);
    if (!message || message.length > 100_000) throw new Error("Message is empty or too long");
    const conflicting = this.#sessions.state.sessions.find(
      (candidate) =>
        candidate.id !== session.id &&
        candidate.projectDirectory === session.projectDirectory &&
        isAgentSessionBusy(candidate),
    );
    if (conflicting) throw new Error(`“${conflicting.title}” is already editing this project`);
    if (isAgentSessionBusy(session)) throw new Error("This agent is already working");
  }

  #startTurn(
    session: AgentSessionSnapshot,
    message: string,
  ): { turnId: string; turnNumber: number } {
    const turnId = crypto.randomUUID();
    session.activeTurnId = turnId;
    session.status = "starting";
    session.updatedAt = now();
    if (session.events.length === 0) session.title = titleFromMessage(message);
    this.#appendEvent(session, { kind: "user-message", text: message, turnId });
    this.#changed(session.projectDirectory);
    return { turnId, turnNumber: session.checkpoints.length + 1 };
  }

  #runtimeMessage(message: string, context: AgentTurnContext): string {
    const contextLines = [
      `Project revision: ${this.projectStore.session().revision}`,
      context.activeSequenceId ? `Active sequence: ${context.activeSequenceId}` : "",
      context.playheadUs === undefined ? "" : `Playhead: ${context.playheadUs} microseconds`,
      context.selectedIds?.length ? `Selected IDs: ${context.selectedIds.join(", ")}` : "",
    ].filter(Boolean);
    return `${contextLines.join("\n")}\n\nUser request:\n${message}`;
  }

  #failTurnStart(session: AgentSessionSnapshot, turnId: string, error: unknown): void {
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

  async interrupt(sessionId: string): Promise<AgentProjectSnapshot> {
    const session = this.#requireSession(sessionId);
    await this.#runtimeCoordinator.interrupt(sessionId);
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
    this.#approvals.resolve({
      sessionId,
      requestId,
      activeTurnId: session.activeTurnId,
      accepted: decision === "accept",
    });
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
    const lease = this.#approvals.intent(sessionId, requestId, session.activeTurnId);
    return { toolName: lease.toolName, detail: lease.detail };
  }

  async close(): Promise<void> {
    this.#streamBatcher.clear();
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    const runningSessionIds = this.#runtimeCoordinator.sessionIds();
    await this.#runtimeCoordinator.close();
    for (const sessionId of runningSessionIds) this.#cancelPendingApprovals(sessionId);
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
    if (!this.#sessionEvents.completeTool(session, eventId, detail, failed)) {
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
    toolName = boundedAgentText(toolName, 256);
    detail = boundedAgentText(detail, MAX_APPROVAL_DETAIL_BYTES);
    const turnId = session.activeTurnId;
    const { lease, decision } = this.#approvals.request({
      sessionId,
      turnId,
      toolName,
      detail,
      expired: (expiredLease) => this.#approvalExpired(expiredLease),
    });
    session.status = "waiting";
    this.#appendEvent(session, {
      kind: "approval-requested",
      requestId: lease.requestId,
      title: `Allow ${toolName.replaceAll("_", " ")}?`,
      detail,
      destructive: true,
      status: "running",
      turnId,
    });
    this.#changed(session.projectDirectory);
    return decision;
  }

  onProjectChanged(): void {
    this.notifyProjectChanged();
  }

  #recordProviderSessionId(sessionId: string, providerSessionId: string): void {
    const session = this.#requireSession(sessionId);
    session.providerSessionId = boundedAgentText(providerSessionId, 512);
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
  }

  #recordTurnStarted(sessionId: string, providerTurnId?: string): void {
    const session = this.#requireSession(sessionId);
    session.status = "working";
    if (providerTurnId && !session.activeTurnId) session.activeTurnId = providerTurnId;
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
  }

  #recordTokenUsage(sessionId: string, usage: Omit<AgentTokenUsage, "updatedAt">): void {
    const session = this.#requireSession(sessionId);
    session.tokenUsage = { ...usage, updatedAt: now() };
    session.updatedAt = now();
    this.#streamChanged(session.projectDirectory);
  }

  #runtimeEvent(sessionId: string, event: AgentRuntimeEvent): void {
    const session = this.#requireSession(sessionId);
    this.#sessionEvents.appendRuntime(session, event);
    session.updatedAt = now();
    this.#streamChanged(session.projectDirectory);
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
    await this.#recordTurnCheckpoint(session, turnId, turnNumber);
    this.#appendTurnResult(session, turnId, status, detail);
    session.status = status === "completed" ? "completed" : status;
    session.activeTurnId = undefined;
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
    await this.#flushSave();
  }

  async #recordTurnCheckpoint(
    session: AgentSessionSnapshot,
    turnId: string,
    turnNumber: number,
  ): Promise<void> {
    try {
      const checkpoint = await this.#turns.complete(session, turnId, turnNumber);
      session.checkpoints.push(checkpoint);
      this.#appendEvent(session, {
        kind: "checkpoint",
        title:
          checkpoint.summary === "No canonical project changes"
            ? "No project changes"
            : "Turn checkpoint",
        detail: checkpoint.summary,
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
  }

  #appendTurnResult(
    session: AgentSessionSnapshot,
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    detail?: string,
  ): void {
    if (!detail) return;
    this.#appendEvent(session, {
      kind: status === "failed" ? "error" : "notice",
      title: status === "failed" ? "Turn failed" : "Turn interrupted",
      detail,
      turnId,
    });
  }

  async #stopRuntime(sessionId: string): Promise<void> {
    await this.#runtimeCoordinator.stop(sessionId);
    this.#cancelPendingApprovals(sessionId);
  }

  async #providerExited(sessionId: string, detail?: string): Promise<void> {
    this.#cancelPendingApprovals(sessionId);
    const session = this.#sessions.state.sessions.find((candidate) => candidate.id === sessionId);
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
    const session = this.#sessions.state.sessions.find((candidate) => candidate.id === sessionId);
    for (const lease of this.#approvals.cancelSession(sessionId))
      if (session)
        this.#appendEvent(session, {
          kind: "approval-resolved",
          requestId: lease.requestId,
          title: "Cancelled",
          status: "declined",
          turnId: lease.turnId,
        });
  }

  #approvalExpired(lease: AgentApprovalLease): void {
    const session = this.#sessions.state.sessions.find(
      (candidate) => candidate.id === lease.sessionId,
    );
    if (!session) return;
    session.status = session.activeTurnId === lease.turnId ? "working" : session.status;
    this.#appendEvent(session, {
      kind: "approval-resolved",
      requestId: lease.requestId,
      title: "Approval expired",
      status: "declined",
      turnId: lease.turnId,
    });
    this.#changed(session.projectDirectory);
  }

  #appendEvent(
    session: AgentSessionSnapshot,
    input: Omit<AgentEvent, "id" | "sessionId" | "createdAt">,
  ): AgentEvent {
    return this.#sessionEvents.append(session, input);
  }

  #requireOpenProject(projectDirectory: string): void {
    if (this.projectStore.directory !== projectDirectory || !this.projectStore.project)
      throw new Error("Open this agent's Cinesim project before continuing");
  }

  #requireSession(sessionId: string): AgentSessionSnapshot {
    return this.#sessions.require(sessionId);
  }

  #changed(projectDirectory: string): AgentProjectSnapshot {
    this.#streamBatcher.cancel(projectDirectory);
    const snapshot = this.#projectSnapshot(projectDirectory);
    snapshot.revision = this.#events.publish(snapshot);
    this.#scheduleSave();
    return snapshot;
  }

  #streamChanged(projectDirectory: string): void {
    this.#streamBatcher.schedule(projectDirectory, () => this.#changed(projectDirectory));
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#save();
    }, PERSISTENCE_INTERVAL_MS);
  }

  async #flushSave(): Promise<void> {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    await this.#save();
  }

  async #save(): Promise<void> {
    await this.#sessionStore.write(this.#sessions.state);
  }
}
