import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProjectSnapshot,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSessionUpdate,
  AgentSettings,
  AgentTurnContext,
  DesktopProjectSession,
} from "../../shared/contracts";
import { useRendererStore } from "../store/renderer-store-context";
import {
  cacheAgentProject,
  cacheAgentProviders,
  cacheAgentSettings,
  cachedAgentProject,
  cachedAgentProviders,
  cachedAgentSettings,
} from "../lib/agent-presentation-cache";
import { applyAgentProjectDelta } from "../lib/agent-project-delta";

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function preferredProvider(
  providers: readonly AgentProviderStatus[],
  settings: AgentSettings,
): AgentProviderStatus | undefined {
  const connected = providers.filter((status) => status.state === "connected");
  return connected.find((status) => status.provider === settings.defaultProvider) ?? connected[0];
}

interface AgentTurnContextInput {
  workspace: "media" | "cut" | "edit";
  activeSequenceId: string | null;
  playheadUs: number;
  selectedAssetIds: readonly string[];
  selectedClipId: string | null;
  session: Pick<DesktopProjectSession, "diskValid" | "diagnostics" | "candidateDiagnostics">;
}

export function buildAgentTurnContext(input: AgentTurnContextInput): AgentTurnContext {
  const selectedClipIds = input.selectedClipId ? [input.selectedClipId] : [];
  const selectedIds = [...input.selectedAssetIds, ...selectedClipIds];
  const diagnostics = input.session.diskValid
    ? input.session.diagnostics
    : input.session.candidateDiagnostics;
  return {
    workspace: input.workspace,
    ...(input.activeSequenceId ? { activeSequenceId: input.activeSequenceId } : {}),
    playheadUs: input.playheadUs,
    ...(selectedIds.length > 0 ? { selectedIds } : {}),
    ...(input.selectedAssetIds.length > 0 ? { selectedAssetIds: [...input.selectedAssetIds] } : {}),
    ...(selectedClipIds.length > 0 ? { selectedClipIds } : {}),
    compiler: {
      diskValid: input.session.diskValid,
      diagnosticCount: diagnostics.length,
      diagnostics: diagnostics.slice(0, 20).map(({ code, message }) => ({ code, message })),
    },
  };
}

export function useAgentProjectController(session: DesktopProjectSession) {
  const [snapshot, setSnapshot] = useState<AgentProjectSnapshot | null>(() =>
    cachedAgentProject(session.directory),
  );
  const [settings, setSettings] = useState<AgentSettings | null>(() => cachedAgentSettings());
  const [providers, setProviders] = useState<AgentProviderStatus[]>(() => cachedAgentProviders());
  const [composer, setComposer] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const workspace = useRendererStore((state) => state.projectSection);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const selectedAssetIds = useRendererStore((state) => state.selectedAssetIds);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);

  useEffect(() => {
    let active = true;
    async function loadSnapshot(): Promise<AgentProjectSnapshot | null> {
      try {
        const next = await window.cinesim.agents.get(session.directory);
        cacheAgentProject(next);
        if (active) setSnapshot(next);
        return next;
      } catch (caught) {
        if (active) setError(messageFrom(caught, "Could not load agents"));
        return null;
      }
    }

    async function loadSettings(): Promise<AgentSettings | null> {
      try {
        const next = await window.cinesim.agents.getSettings();
        cacheAgentSettings(next);
        if (active) setSettings(next);
        return next;
      } catch (caught) {
        if (active) setError(messageFrom(caught, "Could not load agent settings"));
        return null;
      }
    }

    async function loadProviders(): Promise<AgentProviderStatus[] | null> {
      try {
        const next = await window.cinesim.agents.refreshProviders();
        cacheAgentProviders(next);
        if (active) setProviders(next);
        return next;
      } catch (caught) {
        if (active) setError(messageFrom(caught, "Could not inspect local agents"));
        return null;
      }
    }

    async function ensureInitialSession(
      initial: AgentProjectSnapshot,
      agentSettings: AgentSettings,
      providerStatuses: readonly AgentProviderStatus[],
    ): Promise<AgentProjectSnapshot> {
      if (initial.sessions.length > 0) return initial;
      const preferred = preferredProvider(providerStatuses, agentSettings);
      if (!preferred) return initial;
      try {
        return await window.cinesim.agents.ensure({
          projectDirectory: session.directory,
          provider: preferred.provider,
        });
      } catch (caught) {
        if (active) setError(messageFrom(caught, "Could not prepare a project agent"));
        return initial;
      }
    }

    async function initialize(): Promise<void> {
      const [agentSnapshot, agentSettings, providerStatuses] = await Promise.all([
        loadSnapshot(),
        loadSettings(),
        loadProviders(),
      ]);
      if (!active || !agentSnapshot || !agentSettings || !providerStatuses) return;
      const nextSnapshot = await ensureInitialSession(
        agentSnapshot,
        agentSettings,
        providerStatuses,
      );
      if (active) {
        cacheAgentProject(nextSnapshot);
        setSnapshot(nextSnapshot);
      }
    }

    void initialize();
    const unsubscribe = window.cinesim.agents.onDelta((delta) => {
      if (delta.projectDirectory !== session.directory) return;
      setSnapshot((current) => {
        const next = applyAgentProjectDelta(current, delta);
        if (!next) {
          void loadSnapshot();
          return current;
        }
        cacheAgentProject(next);
        return next;
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session.directory]);

  const activeSession = useMemo(
    () => snapshot?.sessions.find((candidate) => candidate.id === snapshot.activeSessionId) ?? null,
    [snapshot],
  );

  async function runSnapshotAction(
    operation: () => Promise<AgentProjectSnapshot>,
    fallback: string,
  ): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      cacheAgentProject(next);
      setSnapshot(next);
      busyRef.current = false;
      setBusy(false);
      return true;
    } catch (caught) {
      setError(messageFrom(caught, fallback));
      busyRef.current = false;
      setBusy(false);
      return false;
    }
  }

  async function create(provider: AgentProviderKind): Promise<void> {
    if (
      await runSnapshotAction(
        () => window.cinesim.agents.create({ projectDirectory: session.directory, provider }),
        "Could not create agent",
      )
    )
      setCreating(false);
  }

  async function sendMessage(): Promise<void> {
    if (!activeSession || !composer.trim() || busy) return;
    const message = composer;
    setComposer("");
    const succeeded = await runSnapshotAction(
      () =>
        window.cinesim.agents.send(
          activeSession.id,
          message,
          buildAgentTurnContext({
            workspace,
            activeSequenceId,
            playheadUs,
            selectedAssetIds,
            selectedClipId,
            session,
          }),
        ),
      "Could not send message",
    );
    if (!succeeded) setComposer(message);
  }

  async function updateActiveSession(update: AgentSessionUpdate): Promise<void> {
    if (!activeSession) return;
    await runSnapshotAction(
      () => window.cinesim.agents.update(activeSession.id, update),
      "Could not update agent settings",
    );
  }

  return {
    snapshot,
    settings,
    providers,
    activeSession,
    activeSequenceId,
    playheadUs,
    composer,
    setComposer,
    creating,
    setCreating,
    busy,
    error,
    clearError: () => setError(null),
    create,
    sendMessage,
    updateActiveSession,
    selectAgent: (sessionId: string) =>
      runSnapshotAction(
        () => window.cinesim.agents.select(session.directory, sessionId),
        "Could not select agent",
      ),
    deleteAgent: (sessionId: string) =>
      runSnapshotAction(
        () => window.cinesim.agents.delete(session.directory, sessionId),
        "Could not delete agent",
      ),
    interruptAgent: (sessionId: string) =>
      runSnapshotAction(() => window.cinesim.agents.interrupt(sessionId), "Could not stop agent"),
    respondApproval: (sessionId: string, requestId: string, decision: "accept" | "decline") =>
      runSnapshotAction(
        () => window.cinesim.agents.respondApproval(sessionId, requestId, decision),
        "Could not respond to approval",
      ),
  };
}
