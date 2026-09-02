import { stableJson } from "@cinesim/core";
import { z } from "zod";
import type { AgentSessionSnapshot } from "../../shared/contracts";
import { AtomicFileRepository } from "../app/atomic-file-repository";

const MAX_AGENT_STATE_BYTES = 64 * 1024 * 1024;
const timestamp = z.iso.datetime();
const boundedId = z.string().min(1).max(512);
const eventSchema = z
  .object({
    id: boundedId,
    sessionId: boundedId,
    turnId: boundedId.optional(),
    kind: z.enum([
      "user-message",
      "assistant-message",
      "reasoning",
      "tool-started",
      "tool-completed",
      "turn-result",
      "notice",
      "error",
    ]),
    createdAt: timestamp,
    text: z.string().max(1_048_576).optional(),
    title: z.string().max(4_096).optional(),
    detail: z.string().max(1_048_576).optional(),
    toolName: z.string().max(256).optional(),
    status: z.enum(["running", "completed", "failed", "interrupted"]).optional(),
  })
  .strict();
const tokenUsageSchema = z
  .object({
    usedTokens: z.number().int().nonnegative().safe(),
    maxTokens: z.number().int().nonnegative().safe().optional(),
    inputTokens: z.number().int().nonnegative().safe().optional(),
    cachedInputTokens: z.number().int().nonnegative().safe().optional(),
    outputTokens: z.number().int().nonnegative().safe().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().safe().optional(),
    totalProcessedTokens: z.number().int().nonnegative().safe().optional(),
    updatedAt: timestamp,
  })
  .strict();
const sessionSchema = z
  .object({
    id: boundedId,
    projectDirectory: z.string().min(1).max(32_768),
    provider: z.enum(["claude", "codex"]),
    model: z.string().min(1).max(120),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    title: z.string().min(1).max(1_024),
    status: z.enum(["idle", "starting", "working", "completed", "interrupted", "failed"]),
    createdAt: timestamp,
    updatedAt: timestamp,
    providerSessionId: boundedId.optional(),
    activeTurnId: boundedId.optional(),
    tokenUsage: tokenUsageSchema.optional(),
    events: z.array(eventSchema).max(600),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    activeSessionByProject: z.record(z.string().min(1).max(32_768), boundedId),
    sessions: z.array(sessionSchema).max(1_000),
  })
  .strict();
const legacyEventSchema = eventSchema.extend({
  kind: z.enum([
    "user-message",
    "assistant-message",
    "reasoning",
    "tool-started",
    "tool-completed",
    "turn-result",
    "notice",
    "error",
    "approval-requested",
    "approval-resolved",
    "checkpoint",
  ]),
  status: z.enum(["running", "completed", "failed", "interrupted", "declined"]).optional(),
  requestId: boundedId.optional(),
  destructive: z.boolean().optional(),
});
const legacySessionSchema = sessionSchema.extend({
  status: z.enum(["idle", "starting", "working", "waiting", "completed", "interrupted", "failed"]),
  permissionMode: z.enum(["supervised", "auto-edit"]).optional(),
  events: z.array(legacyEventSchema).max(600),
  checkpoints: z.array(z.unknown()).max(10_000).optional(),
});
const readableStateSchema = stateSchema.extend({
  sessions: z.array(legacySessionSchema).max(1_000),
});

export interface PersistedAgentState {
  version: 1;
  activeSessionByProject: Record<string, string>;
  sessions: AgentSessionSnapshot[];
}

export class AgentSessionStore {
  readonly #files = new AtomicFileRepository();

  constructor(private readonly path: string) {}

  async read(): Promise<PersistedAgentState> {
    const value = JSON.parse(
      await this.#files.readText(this.path, MAX_AGENT_STATE_BYTES),
    ) as unknown;
    const parsed = readableStateSchema.parse(value);
    const migrated = {
      ...parsed,
      sessions: parsed.sessions.map(
        ({ permissionMode: _permissionMode, checkpoints: _checkpoints, ...session }) => ({
          ...session,
          status: session.status === "waiting" ? "interrupted" : session.status,
          ...(session.status === "waiting" ? { activeTurnId: undefined } : {}),
          events: session.events
            .filter(
              (event) =>
                event.kind !== "approval-requested" &&
                event.kind !== "approval-resolved" &&
                event.kind !== "checkpoint",
            )
            .map(({ requestId: _requestId, destructive: _destructive, status, ...event }) => ({
              ...event,
              ...(status && status !== "declined" ? { status } : {}),
            })),
        }),
      ),
    };
    return stateSchema.parse(migrated) as PersistedAgentState;
  }

  async write(value: PersistedAgentState): Promise<void> {
    const contents = stableJson(stateSchema.parse(value));
    await this.#files.writeText(this.path, contents, { maxBytes: MAX_AGENT_STATE_BYTES });
  }
}
