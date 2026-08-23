import { useEffect, useState } from "react";
import type { DesktopAppState, DesktopProjectSession } from "../shared/api";
import { AgentsSidebar } from "./components/agents-sidebar";
import { AppShell } from "./components/app-shell";
import { Settings } from "./components/settings";
import { TopBar } from "./components/top-bar";
import { Welcome } from "./components/welcome";
import { Workspace } from "./components/workspace";

type Destination = "home" | "project" | "settings";

const EMPTY_APP_STATE: DesktopAppState = {
  version: 1,
  recentProjects: [],
  projectViews: {},
};

export function App() {
  const [session, setSession] = useState<DesktopProjectSession | null>(null);
  const [appState, setAppState] = useState<DesktopAppState>(EMPTY_APP_STATE);
  const [destination, setDestination] = useState<Destination>("home");
  const [settingsSection, setSettingsSection] = useState<"general" | "agents">("general");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([window.cinesim.getSession(), window.cinesim.getAppState()])
      .then(([currentSession, currentAppState]) => {
        setSession(currentSession);
        setAppState(currentAppState);
        if (currentSession) setDestination("project");
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Cinesim could not start"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => window.cinesim.onProjectChanged(setSession), []);

  async function showProject(nextSession: DesktopProjectSession): Promise<void> {
    setSession(nextSession);
    setDestination("project");
    setError(null);
    setAppState(await window.cinesim.getAppState());
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
      settingsSection={settingsSection}
      title={title}
      toolbar={
        destination === "project" && session ? (
          <TopBar session={session} onSession={setSession} />
        ) : null
      }
      onHome={() => setDestination("home")}
      onProject={() => session && setDestination("project")}
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
          initialView={appState.projectViews[session.directory]}
          onSession={setSession}
          onAppState={setAppState}
        />
      ) : (
        <Welcome appState={appState} error={error} onOpen={(next) => void showProject(next)} />
      )}
    </AppShell>
  );
}
