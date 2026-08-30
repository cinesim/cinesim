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
import type { AgentProviderRuntime, AgentRuntimeEvent } from "./runtimes/types";
import { createAgentRuntime } from "./runtimes/factory";
import { AgentSessionStore } from "./session-store";
import { AgentSessionRegistry } from "./session-registry";
import type { AgentSettingsStore } from "./settings-store";
import type { DesktopProjectStore } from "../projects/project-store";
import { AgentEventPublisher } from "./event-publisher";
import { AgentApprovalBroker } from "./approval-broker";
import type { AgentApprovalLease } from "./approval-broker";
import { AgentRuntimeRegistry } from "./runtime-registry";
import { AgentStreamBatcher } from "./stream-batcher";
import { AgentTurnCoordinator } from "./turn-coordinator";

const MAX_EVENTS_PER_SESSION = 600;
const APPROVAL_LEASE_MS = 2 * 60 * 1_000;
const STREAM_PUBLICATION_INTERVAL_MS = 40;
const PERSISTENCE_INTERVAL_MS = 1_000;
const MAX_EVENT_TEXT_BYTES = 1024 * 1024;
const MAX_EVENT_DETAIL_BYTES = 1024 * 1024;
const MAX_SESSION_EVENT_BYTES = 8 * 1024 * 1024;

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

function boundedUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value);
  return encoded.byteLength <= maximumBytes
    ? value
    : `${encoded.subarray(0, Math.max(0, maximumBytes - 3)).toString("utf8")}…`;
}

function normalizeEventStrings(event: AgentEvent): void {
  if (event.text) event.text = boundedUtf8(event.text, MAX_EVENT_TEXT_BYTES);
  if (event.detail) event.detail = boundedUtf8(event.detail, MAX_EVENT_DETAIL_BYTES);
  if (event.title) event.title = boundedUtf8(event.title, 4_096);
  if (event.toolName) event.toolName = boundedUtf8(event.toolName, 256);
}

function eventBytes(event: AgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

export class AgentCoordinator implements AgentToolHooks {
  #sessions = new AgentSessionRegistry();
  #runtimes = new AgentRuntimeRegistry();
  #approvals = new AgentApprovalBroker(APPROVAL_LEASE_MS);
  #turns = new AgentTurnCoordinator();
  #saveTimer: NodeJS.Timeout | null = null;
  #streamBatcher = new AgentStreamBatcher(STREAM_PUBLICATION_INTERVAL_MS);
  #sessionEventBytes = new Map<string, number>();
  #sessionStore: AgentSessionStore;
  #events: AgentEventPublisher;
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
  }

  async load(): Promise<void> {
    try {
      const providerSettings = this.settingsStore.snapshot().providers;
      const candidate = await this.#sessionStore.read({
        claude: providerSettings.claude.effort,
        codex: providerSettings.codex.effort,
      });
      const sessions = candidate.sessions;
      for (const session of sessions) {
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
        for (const event of session.events) normalizeEventStrings(event);
        this.#enforceSessionEventBudget(session, true);
      }
      this.#sessions.replace({
        version: 1,
        sessions,
        activeSessionByProject: candidate.activeSessionByProject,
      });
    } catch {
      this.#sessions.reset();
    }
    await this.mcpServer.start();
    this.#scheduleSave();
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
    this.#sessions.state.sessions = this.#sessions.state.sessions.filter(
      (candidate) => candidate.id !== sessionId,
    );
    this.#sessionEventBytes.delete(sessionId);
    if (this.#sessions.state.activeSessionByProject[projectDirectory] === sessionId)
      delete this.#sessions.state.activeSessionByProject[projectDirectory];
    return this.#changed(projectDirectory);
  }

  async removeProject(projectDirectory: string): Promise<void> {
    const sessionIds = this.#sessions.state.sessions
      .filter((session) => session.projectDirectory === projectDirectory)
      .map((session) => session.id);
    await Promise.all(sessionIds.map((sessionId) => this.#stopRuntime(sessionId)));
    for (const sessionId of sessionIds) this.#sessionEventBytes.delete(sessionId);
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
    this.#requireOpenProject(session.projectDirectory);
    const message = rawMessage.trim();
    if (!message || message.length > 100_000) throw new Error("Message is empty or too long");
    const conflicting = this.#sessions.state.sessions.find(
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

    try {
      await this.#turns.captureBefore(session, turnNumber);
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
    await this.#turns.restore(session, checkpoint);
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
    this.#streamBatcher.clear();
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    for (const sessionId of this.#runtimes.sessionIds()) await this.#stopRuntime(sessionId);
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
      normalizeEventStrings(started);
      this.#enforceSessionEventBudget(session, true);
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
    toolName = boundedUtf8(toolName, 256);
    detail = boundedUtf8(detail, MAX_EVENT_DETAIL_BYTES);
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
        session.providerSessionId = boundedUtf8(providerSessionId, 512);
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
        this.#streamChanged(session.projectDirectory);
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
      this.#runtimes.remove(session.id);
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
      const sessionBytes =
        this.#sessionEventBytes.get(session.id) ??
        session.events.reduce((total, candidate) => total + eventBytes(candidate), 0);
      const previousBytes = eventBytes(last);
      last.text = boundedUtf8(`${last.text ?? ""}${event.text}`, MAX_EVENT_TEXT_BYTES);
      last.createdAt = now();
      this.#sessionEventBytes.set(session.id, sessionBytes - previousBytes + eventBytes(last));
    } else {
      this.#appendEvent(session, {
        ...event,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      });
    }
    this.#enforceSessionEventBudget(session);
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
    await this.#flushSave();
  }

  async #stopRuntime(sessionId: string): Promise<void> {
    await this.#runtimes.stop(sessionId);
    this.mcpServer.revokeSession(sessionId);
    this.#cancelPendingApprovals(sessionId);
  }

  async #providerExited(sessionId: string, detail?: string): Promise<void> {
    const wasRegistered = this.#runtimes.remove(sessionId);
    if (!wasRegistered) return;
    this.mcpServer.revokeSession(sessionId);
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
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      createdAt: now(),
      ...input,
    };
    normalizeEventStrings(event);
    session.events.push(event);
    this.#sessionEventBytes.set(
      session.id,
      (this.#sessionEventBytes.get(session.id) ?? 0) + eventBytes(event),
    );
    this.#enforceSessionEventBudget(session);
    return event;
  }

  #enforceSessionEventBudget(session: AgentSessionSnapshot, recalculate = false): void {
    let bytes =
      recalculate || !this.#sessionEventBytes.has(session.id)
        ? session.events.reduce((total, event) => total + eventBytes(event), 0)
        : this.#sessionEventBytes.get(session.id)!;
    while (
      session.events.length > 1 &&
      (session.events.length > MAX_EVENTS_PER_SESSION || bytes > MAX_SESSION_EVENT_BYTES)
    ) {
      bytes -= eventBytes(session.events.shift()!);
    }
    this.#sessionEventBytes.set(session.id, bytes);
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

  #instructions(): string {
    return `You are working inside Cinesim, a local-first nonlinear video editor.

Use the cinesim MCP tools for every canonical project edit. Never write cinesim.json or files under .cinesim directly. Inspect the current project and timeline before editing. All timeline times are integer microseconds and all entities are addressed by stable IDs. Source media is referenced in place and must never be moved, overwritten, or deleted. Files under .video are derived and disposable. Explain completed changes clearly and mention the stable IDs you changed.`;
  }
}
