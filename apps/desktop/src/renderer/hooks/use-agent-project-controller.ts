import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProjectSnapshot,
  AgentProviderKind,
  AgentProviderStatus,
  AgentSessionUpdate,
  AgentSettings,
  AgentTurnContext,
  DesktopProjectSession,
} from "../../shared/api";
import { useRendererStore } from "../store/renderer-store-context";

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function buildAgentTurnContext(
  activeSequenceId: string | null,
  playheadUs: number,
  selectedClipId: string | null,
): AgentTurnContext {
  return {
    ...(activeSequenceId ? { activeSequenceId } : {}),
    playheadUs,
    ...(selectedClipId ? { selectedIds: [selectedClipId] } : {}),
  };
}

export function useAgentProjectController(session: DesktopProjectSession) {
  const [snapshot, setSnapshot] = useState<AgentProjectSnapshot | null>(null);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [providers, setProviders] = useState<AgentProviderStatus[]>([]);
  const [composer, setComposer] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setSettings(null);
    setProviders([]);
    setError(null);
    void Promise.all([
      window.cinesim.getAgents(session.directory),
      window.cinesim.getAgentSettings(),
      window.cinesim.refreshAgentProviders(),
    ])
      .then(async ([agentSnapshot, agentSettings, providerStatuses]) => {
        if (!active) return;
        setSettings(agentSettings);
        setProviders(providerStatuses);
        let nextSnapshot = agentSnapshot;
        if (agentSnapshot.sessions.length === 0) {
          const connected = providerStatuses.filter((status) => status.state === "connected");
          const preferred =
            connected.find((status) => status.provider === agentSettings.defaultProvider) ??
            connected[0];
          if (preferred) {
            try {
              nextSnapshot = await window.cinesim.ensureAgent({
                projectDirectory: session.directory,
                provider: preferred.provider,
              });
            } catch (caught) {
              if (active) setError(messageFrom(caught, "Could not prepare a project agent"));
            }
          }
        }
        if (active) setSnapshot(nextSnapshot);
      })
      .catch((caught) => {
        if (active) setError(messageFrom(caught, "Could not load agents"));
      });
    const unsubscribe = window.cinesim.onAgentsChanged((next) => {
      if (next.projectDirectory === session.directory) setSnapshot(next);
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
      setSnapshot(await operation());
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
        () => window.cinesim.createAgent({ projectDirectory: session.directory, provider }),
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
        window.cinesim.sendAgentMessage(
          activeSession.id,
          message,
          buildAgentTurnContext(activeSequenceId, playheadUs, selectedClipId),
        ),
      "Could not send message",
    );
    if (!succeeded) setComposer(message);
  }

  async function updateActiveSession(update: AgentSessionUpdate): Promise<void> {
    if (!activeSession) return;
    await runSnapshotAction(
      () => window.cinesim.updateAgent(activeSession.id, update),
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
    create,
    sendMessage,
    updateActiveSession,
    selectAgent: (sessionId: string) =>
      runSnapshotAction(
        () => window.cinesim.selectAgent(session.directory, sessionId),
        "Could not select agent",
      ),
    deleteAgent: (sessionId: string) =>
      runSnapshotAction(
        () => window.cinesim.deleteAgent(session.directory, sessionId),
        "Could not delete agent",
      ),
    interruptAgent: (sessionId: string) =>
      runSnapshotAction(() => window.cinesim.interruptAgent(sessionId), "Could not stop agent"),
    respondApproval: (sessionId: string, requestId: string, decision: "accept" | "decline") =>
      runSnapshotAction(
        () => window.cinesim.respondAgentApproval(sessionId, requestId, decision),
        "Could not respond to approval",
      ),
    revertTurn: (sessionId: string, turnId: string) =>
      runSnapshotAction(
        () => window.cinesim.revertAgentTurn(sessionId, turnId),
        "Could not revert agent turn",
      ),
  };
}
