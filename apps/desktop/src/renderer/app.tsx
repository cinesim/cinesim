import { useEffect, useState } from "react";
import { Library } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { DesktopAppState, DesktopProjectSession } from "../shared/api";
import { AgentsSidebar } from "./components/agents-sidebar";
import { AppShell } from "./components/app-shell";
import { Settings } from "./components/settings";
import { TopBar } from "./components/top-bar";
import { Welcome } from "./components/welcome";
import { Workspace } from "./components/workspace";

type Destination = "home" | "project" | "settings";
type ProjectSection = "media" | "edit";

const EMPTY_APP_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  mediaPoolOpenByProject: {},
};

export function App() {
  const [session, setSession] = useState<DesktopProjectSession | null>(null);
  const [appState, setAppState] = useState<DesktopAppState>(EMPTY_APP_STATE);
  const [destination, setDestination] = useState<Destination>("home");
  const [projectSection, setProjectSection] = useState<ProjectSection>("media");
  const [activeSequenceId, setActiveSequenceId] = useState<string | null>(null);
  const [mediaPoolOpen, setMediaPoolOpen] = useState(true);
  const [settingsSection, setSettingsSection] = useState<"general" | "agents">("general");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([window.cinesim.getSession(), window.cinesim.getAppState()])
      .then(([currentSession, currentAppState]) => {
        setSession(currentSession);
        setAppState(currentAppState);
        if (currentSession) {
          setActiveSequenceId(currentSession.project.activeSequenceId);
          setMediaPoolOpen(
            currentAppState.mediaPoolOpenByProject[currentSession.directory] ?? true,
          );
          setDestination("project");
        }
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Cinesim could not start"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => window.cinesim.onProjectChanged(setSession), []);

  async function showProject(nextSession: DesktopProjectSession): Promise<void> {
    const nextAppState = await window.cinesim.getAppState();
    setSession(nextSession);
    setProjectSection("media");
    setActiveSequenceId(nextSession.project.activeSequenceId);
    setMediaPoolOpen(nextAppState.mediaPoolOpenByProject[nextSession.directory] ?? true);
    setDestination("project");
    setError(null);
    setAppState(nextAppState);
  }

  async function openRecent(directory: string): Promise<void> {
    try {
      await showProject(await window.cinesim.openRecentProject(directory));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The project could not be opened");
      setDestination("home");
    }
  }

  async function openProject(): Promise<void> {
    try {
      const nextSession = await window.cinesim.openProject();
      if (nextSession) await showProject(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The project could not be opened");
      setDestination("home");
    }
  }

  function showProjectSection(section: ProjectSection): void {
    if (!session) return;
    setProjectSection(section);
    setDestination("project");
  }

  function toggleMediaPool(): void {
    if (!session) return;
    const nextOpen = !mediaPoolOpen;
    setMediaPoolOpen(nextOpen);
    void window.cinesim
      .setProjectMediaPoolOpen(nextOpen)
      .then(setAppState)
      .catch(() => {
        setMediaPoolOpen(!nextOpen);
      });
  }

  if (loading)
    return (
      <div className="app-drag grid h-screen place-items-center bg-canvas text-ui text-muted">
        Preparing Cinesim…
      </div>
    );

  const title =
    destination === "settings"
      ? "Settings"
      : destination === "project" && session
        ? session.project.name
        : "Home";

  return (
    <AppShell
      session={session}
      appState={appState}
      destination={destination}
      projectSection={projectSection}
      activeSequenceId={activeSequenceId}
      settingsSection={settingsSection}
      title={title}
      leadingToolbar={
        destination === "project" && session && projectSection === "edit" ? (
          <Button
            size="sm"
            variant={mediaPoolOpen ? "secondary" : "ghost"}
            aria-pressed={mediaPoolOpen}
            onClick={toggleMediaPool}
          >
            <Library size={13} /> Media Pool
          </Button>
        ) : undefined
      }
      toolbar={
        destination === "project" && session ? (
          <TopBar session={session} onSession={setSession} />
        ) : null
      }
      onHome={() => setDestination("home")}
      onProjectSection={showProjectSection}
      onTimeline={(sequenceId) => {
        setActiveSequenceId(sequenceId);
        setProjectSection("edit");
      }}
      onSettings={() => setDestination("settings")}
      onSettingsSection={setSettingsSection}
      onOpenRecent={(directory) => void openRecent(directory)}
      onOpenProject={() => void openProject()}
      agentsSidebar={
        destination === "project" && session ? (
          <AgentsSidebar
            session={session}
            onConfigure={() => {
              setSettingsSection("agents");
              setDestination("settings");
            }}
          />
        ) : undefined
      }
    >
      {destination === "settings" ? (
        <Settings section={settingsSection} />
      ) : destination === "project" && session ? (
        <Workspace
          key={session.directory}
          session={session}
          section={projectSection}
          activeSequenceId={activeSequenceId ?? session.project.activeSequenceId}
          mediaPoolOpen={mediaPoolOpen}
          onOpenTimeline={(sequenceId) => {
            setActiveSequenceId(sequenceId);
            setProjectSection("edit");
          }}
          onSession={setSession}
        />
      ) : (
        <Welcome appState={appState} error={error} onOpen={(next) => void showProject(next)} />
      )}
    </AppShell>
  );
}
