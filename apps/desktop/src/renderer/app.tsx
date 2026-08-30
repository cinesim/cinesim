import { Library, SlidersHorizontal, StickyNote } from "@cinesim/ui";
import { Button, TooltipProvider } from "@cinesim/ui";
import { AgentsSidebar } from "./components/agents/agents-sidebar";
import { Welcome, WelcomeLoadingState } from "./components/home/welcome";
import { MetricsSidebar } from "./components/metrics/metrics-sidebar";
import { Settings } from "./components/settings/settings";
import { AppShell, toggleAuxiliaryMode } from "./components/shell/app-shell";
import { TopBar } from "./components/shell/top-bar";
import { Workspace } from "./components/workspace/workspace";
import { useAppController } from "./hooks/use-app-controller";

export function App() {
  const {
    session,
    appState,
    destination,
    projectSection,
    activeSequenceId,
    mediaPoolOpen,
    inspectorOpen,
    notesOpen,
    settingsSection,
    account,
    accountHydrated,
    auxiliaryMode,
    error,
    editorLayout,
    cutLayout,
    navigate,
    showProjectSection,
    showTimeline,
    setSettingsSection,
    beginAccountSignIn,
    signOutAccount,
    setAuxiliaryMode,
    togglePanel,
    openProject,
    openRecentProject,
    createProject,
    forgetProject,
    trashProject,
    loading,
    openingProject,
    showStartupLoading,
    showProjectOpening,
    title,
  } = useAppController();

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
              key={session.directory}
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
              cutLayout={cutLayout}
              onOpenTimeline={showTimeline}
            />
          ) : (
            <Welcome
              appState={appState}
              error={error}
              loading={false}
              opening={openingProject}
              account={account}
              onCreate={createProject}
              onSignIn={beginAccountSignIn}
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
