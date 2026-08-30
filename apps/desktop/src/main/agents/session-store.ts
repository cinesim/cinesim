import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stableJson } from "@cinesim/core";
import { z } from "zod";
import type { AgentEffort, AgentProviderKind, AgentSessionSnapshot } from "../../shared/contracts";

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
      "approval-requested",
      "approval-resolved",
      "checkpoint",
      "notice",
      "error",
    ]),
    createdAt: timestamp,
    text: z.string().max(1_048_576).optional(),
    title: z.string().max(4_096).optional(),
    detail: z.string().max(1_048_576).optional(),
    toolName: z.string().max(256).optional(),
    requestId: boundedId.optional(),
    destructive: z.boolean().optional(),
    status: z.enum(["running", "completed", "failed", "declined"]).optional(),
  })
  .strict();
const checkpointSchema = z
  .object({
    turnId: boundedId,
    turnNumber: z.number().int().positive().safe(),
    beforeRef: z.string().min(1).max(2_048),
    afterRef: z.string().min(1).max(2_048),
    summary: z.string().max(100_000),
    createdAt: timestamp,
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
    permissionMode: z.enum(["supervised", "auto-edit"]),
    title: z.string().min(1).max(1_024),
    status: z.enum([
      "idle",
      "starting",
      "working",
      "waiting",
      "completed",
      "interrupted",
      "failed",
    ]),
    createdAt: timestamp,
    updatedAt: timestamp,
    providerSessionId: boundedId.optional(),
    activeTurnId: boundedId.optional(),
    tokenUsage: tokenUsageSchema.optional(),
    events: z.array(eventSchema).max(600),
    checkpoints: z.array(checkpointSchema).max(10_000),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    activeSessionByProject: z.record(z.string().min(1).max(32_768), boundedId),
    sessions: z.array(sessionSchema).max(1_000),
  })
  .strict();

export interface PersistedAgentState {
  version: 1;
  activeSessionByProject: Record<string, string>;
  sessions: AgentSessionSnapshot[];
}

export class AgentSessionStore {
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(defaultEffort: Record<AgentProviderKind, AgentEffort>): Promise<PersistedAgentState> {
    const metadata = await stat(this.path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_AGENT_STATE_BYTES)
      throw new Error("Agent session state is outside its size bound");
    const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    return stateSchema.parse(migrateEffort(value, defaultEffort)) as PersistedAgentState;
  }

  async write(value: PersistedAgentState): Promise<void> {
    const contents = stableJson(stateSchema.parse(value));
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const write = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporaryPath, contents, "utf8");
        await rename(temporaryPath, this.path);
      });
    this.#writeQueue = write;
    await write;
  }
}

function migrateEffort(
  value: unknown,
  defaultEffort: Record<AgentProviderKind, AgentEffort>,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.sessions)) return value;
  return {
    ...state,
    sessions: state.sessions.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const session = candidate as Record<string, unknown>;
      if (
        (session.provider === "claude" || session.provider === "codex") &&
        !["low", "medium", "high", "xhigh", "max"].includes(String(session.effort))
      )
        return { ...session, effort: defaultEffort[session.provider] };
      return candidate;
    }),
  };
}
