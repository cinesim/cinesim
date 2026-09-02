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
import { AgentStreamBatcher } from "./stream-batcher";
import { AgentSessionEvents, boundedAgentText } from "./session-events";
import { isAgentSessionBusy, recoverAgentSession } from "./session-recovery";
import { AgentRuntimeCoordinator } from "./runtime-coordinator";

const STREAM_PUBLICATION_INTERVAL_MS = 40;
const PERSISTENCE_INTERVAL_MS = 1_000;

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
  #interruptingSessions = new Set<string>();
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
      title: `New ${input.provider === "claude" ? "Claude" : "Codex"} agent`,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [],
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
      throw new Error("Stop this agent before changing its model or reasoning effort");
    const model = input.model?.trim();
    const nextModel = model || session.model;
    const nextEffort = input.effort ?? session.effort;
    if (nextModel !== session.model || nextEffort !== session.effort) {
      await this.#stopRuntime(sessionId);
      if (nextModel !== session.model) session.tokenUsage = undefined;
      session.model = nextModel;
      session.effort = nextEffort;
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
    const turnId = this.#startTurn(session, message);
    try {
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

  #startTurn(session: AgentSessionSnapshot, message: string): string {
    const turnId = crypto.randomUUID();
    session.activeTurnId = turnId;
    session.status = "starting";
    session.updatedAt = now();
    if (session.events.length === 0) session.title = titleFromMessage(message);
    this.#appendEvent(session, { kind: "user-message", text: message, turnId });
    this.#changed(session.projectDirectory);
    return turnId;
  }

  #runtimeMessage(message: string, context: AgentTurnContext): string {
    const compiler = context.compiler;
    const contextLines = [
      `Project revision: ${this.projectStore.session().revision}`,
      context.workspace ? `Workspace: ${context.workspace}` : "",
      context.activeSequenceId ? `Active sequence: ${context.activeSequenceId}` : "",
      context.playheadUs === undefined ? "" : `Playhead: ${context.playheadUs} microseconds`,
      context.selectedIds?.length ? `Selected IDs: ${context.selectedIds.join(", ")}` : "",
      context.selectedAssetIds?.length
        ? `Selected assets: ${context.selectedAssetIds.join(", ")}`
        : "",
      context.selectedClipIds?.length
        ? `Selected clips: ${context.selectedClipIds.join(", ")}`
        : "",
      compiler
        ? `Compiler: disk ${compiler.diskValid ? "valid" : "invalid"}; ${compiler.diagnosticCount} diagnostic(s)`
        : "",
      ...(compiler?.diagnostics.map(
        (diagnostic) => `Compiler diagnostic ${diagnostic.code}: ${diagnostic.message}`,
      ) ?? []),
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
    this.#interruptingSessions.add(sessionId);
    try {
      await this.#runtimeCoordinator.interrupt(sessionId);
      if (session.activeTurnId)
        await this.#completeTurn(sessionId, "interrupted", "The agent was stopped by the user.");
    } finally {
      this.#interruptingSessions.delete(sessionId);
    }
    return this.snapshot(session.projectDirectory);
  }

  async close(): Promise<void> {
    this.#streamBatcher.clear();
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#runtimeCoordinator.close();
    this.#interruptingSessions.clear();
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

  onProjectChanged(): void {
    this.notifyProjectChanged();
  }

  #recordProviderSessionId(sessionId: string, providerSessionId: string): void {
    const session = this.#requireSession(sessionId);
    session.providerSessionId = boundedAgentText(providerSessionId, 512);
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
  }

  #recordTurnStarted(sessionId: string, _providerTurnId?: string): void {
    const session = this.#requireSession(sessionId);
    if (!session.activeTurnId) return;
    session.status = "working";
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
    if (
      !session.activeTurnId &&
      (event.kind === "assistant-message" ||
        event.kind === "reasoning" ||
        event.kind === "tool-started" ||
        event.kind === "tool-completed")
    )
      return;
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
    if (this.#interruptingSessions.has(sessionId)) {
      status = "interrupted";
      detail = "The agent was stopped by the user.";
    }
    session.activeTurnId = undefined;
    this.#sessionEvents.completeRunningTools(session, turnId, status === "failed");
    this.#appendTurnResult(session, turnId, status, detail);
    session.status = status === "completed" ? "completed" : status;
    session.updatedAt = now();
    this.#changed(session.projectDirectory);
    await this.#flushSave();
  }

  #appendTurnResult(
    session: AgentSessionSnapshot,
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    detail?: string,
  ): void {
    this.#appendEvent(session, {
      kind: "turn-result",
      title:
        status === "completed"
          ? "Turn completed"
          : status === "failed"
            ? "Turn failed"
            : "Interrupted by user",
      ...(detail ? { detail } : {}),
      status,
      turnId,
    });
  }

  async #stopRuntime(sessionId: string): Promise<void> {
    await this.#runtimeCoordinator.stop(sessionId);
  }

  async #providerExited(sessionId: string, detail?: string): Promise<void> {
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
