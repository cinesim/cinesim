import { Library, SlidersHorizontal, StickyNote } from "@cinesim/ui";
import { Button, TooltipProvider } from "@cinesim/ui";
import { AgentsSidebar } from "./components/agents/agents-sidebar";
import { Welcome, WelcomeLoadingState } from "./components/home/welcome";
import { MetricsSidebar } from "./components/metrics/metrics-sidebar";
import { Settings } from "./components/settings/settings";
import { AppShell, toggleAuxiliaryMode } from "./components/shell/app-shell";
import { TopBar } from "./components/shell/top-bar";
import { Workspace } from "./components/workspace/workspace";
import { useDelayedBusy } from "./hooks/use-delayed-busy";
import { editorLayoutFromState, sessionFromLifecycle } from "./store/renderer-store";
import { useRendererStore } from "./store/renderer-store-context";

export function App() {
  const project = useRendererStore((state) => state.project);
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const appState = useRendererStore((state) => state.appState);
  const destination = useRendererStore((state) => state.destination);
  const projectSection = useRendererStore((state) => state.projectSection);
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const mediaPoolOpen = useRendererStore((state) => state.mediaPoolOpen);
  const inspectorOpen = useRendererStore((state) => state.inspectorOpen);
  const notesOpen = useRendererStore((state) => state.notesOpen);
  const settingsSection = useRendererStore((state) => state.settingsSection);
  const account = useRendererStore((state) => state.account);
  const accountHydrated = useRendererStore((state) => state.accountHydrated);
  const auxiliaryMode = useRendererStore((state) => state.auxiliaryMode);
  const error = useRendererStore((state) => state.operationError);
  const editorLayout = useRendererStore(editorLayoutFromState);
  const navigate = useRendererStore((state) => state.navigate);
  const showProjectSection = useRendererStore((state) => state.showProjectSection);
  const showTimeline = useRendererStore((state) => state.showTimeline);
  const setSettingsSection = useRendererStore((state) => state.setSettingsSection);
  const beginAccountSignIn = useRendererStore((state) => state.beginAccountSignIn);
  const signOutAccount = useRendererStore((state) => state.signOutAccount);
  const setAuxiliaryMode = useRendererStore((state) => state.setAuxiliaryMode);
  const togglePanel = useRendererStore((state) => state.togglePanel);
  const openProject = useRendererStore((state) => state.openProject);
  const openRecentProject = useRendererStore((state) => state.openRecentProject);
  const createProject = useRendererStore((state) => state.createProject);
  const forgetProject = useRendererStore((state) => state.forgetProject);
  const trashProject = useRendererStore((state) => state.trashProject);
  const loading = project.status === "booting";
  const openingProject = project.status === "opening";
  const showStartupLoading = useDelayedBusy(loading);
  const showProjectOpening = useDelayedBusy(openingProject);

  const title =
    destination === "settings"
      ? "Settings"
      : destination === "project" && session
        ? session.project.name
        : "Home";

  return (
    <TooltipProvider>
      <AppShell
        session={session}
        appState={appState}
        destination={destination}
        projectSection={projectSection}
        activeSequenceId={activeSequenceId}
        settingsSection={settingsSection}
        account={account}
        accountHydrated={accountHydrated}
        interactionLocked={openingProject}
        title={title}
        leadingToolbar={
          destination === "project" && session && projectSection === "edit" ? (
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant={mediaPoolOpen ? "secondary" : "ghost"}
                aria-label={mediaPoolOpen ? "Hide Media Pool" : "Show Media Pool"}
                aria-pressed={mediaPoolOpen}
                title={mediaPoolOpen ? "Hide Media Pool" : "Show Media Pool"}
                onClick={() => void togglePanel("mediaPool")}
              >
                <Library size={14} />
              </Button>
              <Button
                size="icon"
                variant={inspectorOpen ? "secondary" : "ghost"}
                aria-label={inspectorOpen ? "Hide Inspector" : "Show Inspector"}
                aria-pressed={inspectorOpen}
                title={inspectorOpen ? "Hide Inspector" : "Show Inspector"}
                onClick={() => void togglePanel("inspector")}
              >
                <SlidersHorizontal size={14} />
              </Button>
              <Button
                size="icon"
                variant={notesOpen ? "secondary" : "ghost"}
                aria-label={notesOpen ? "Hide Notes" : "Show Notes"}
                aria-pressed={notesOpen}
                title={notesOpen ? "Hide Notes" : "Show Notes"}
                onClick={() => void togglePanel("notes")}
              >
                <StickyNote size={14} />
              </Button>
            </div>
          ) : undefined
        }
        toolbar={
          destination === "project" && session ? (
            <TopBar
              metricsOpen={auxiliaryMode === "metrics"}
              onToggleMetrics={() =>
                setAuxiliaryMode(toggleAuxiliaryMode(auxiliaryMode, "metrics"))
              }
              agentsOpen={auxiliaryMode === "agents"}
              onToggleAgents={() => setAuxiliaryMode(toggleAuxiliaryMode(auxiliaryMode, "agents"))}
            />
          ) : null
        }
        onHome={() => navigate("home")}
        onProjectSection={showProjectSection}
        onTimeline={showTimeline}
        onSettings={() => {
          setSettingsSection("general");
          navigate("settings");
        }}
        onAccountSignIn={beginAccountSignIn}
        onAccountSignOut={signOutAccount}
        onSettingsSection={setSettingsSection}
        onOpenRecent={(directory) => void openRecentProject(directory)}
        onOpenProject={() => void openProject()}
        agentsSidebar={
          destination === "project" && session ? (
            <AgentsSidebar
              session={session}
              onConfigure={() => {
                setSettingsSection("agents");
                navigate("settings");
              }}
            />
          ) : undefined
        }
        metricsSidebar={destination === "project" && session ? <MetricsSidebar /> : undefined}
        auxiliaryMode={destination === "project" ? auxiliaryMode : null}
        onAuxiliaryMode={setAuxiliaryMode}
      >
        <div className="relative h-full" aria-busy={loading || openingProject}>
          {loading ? (
            showStartupLoading ? (
              <WelcomeLoadingState />
            ) : (
              <section className="h-full bg-canvas" aria-label="Starting Cinesim" />
            )
          ) : destination === "settings" ? (
            <Settings section={settingsSection} />
          ) : destination === "project" && session ? (
            <Workspace
              key={session.directory}
              session={session}
              section={projectSection}
              activeSequenceId={activeSequenceId ?? session.project.activeSequenceId}
              mediaPoolOpen={mediaPoolOpen}
              inspectorOpen={inspectorOpen}
              notesOpen={notesOpen}
              editorLayout={editorLayout}
              onOpenTimeline={showTimeline}
            />
          ) : (
            <Welcome
              appState={appState}
              error={error}
              loading={false}
              opening={openingProject}
              onCreate={createProject}
              onOpen={openProject}
              onOpenRecent={openRecentProject}
              onForgetProject={forgetProject}
              onTrashProject={trashProject}
            />
          )}
          {showProjectOpening && (
            <output className="pointer-events-none absolute right-3 top-3 z-50 flex items-center gap-2 rounded-md border border-border-strong bg-panel/95 px-2.5 py-1.5 text-ui-xs text-muted shadow-lg shadow-black/15">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Opening project…
            </output>
          )}
        </div>
      </AppShell>
    </TooltipProvider>
  );
}
