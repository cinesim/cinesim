import { TooltipProvider } from "@cinesim/ui";
import { Welcome, WelcomeLoadingState } from "./components/home/welcome";
import { Settings } from "./components/settings/settings";
import { AppShell } from "./components/shell/app-shell";
import { Workspace } from "./components/workspace/workspace";
import { useAppRouteController } from "./hooks/use-app-route-controller";

export function App() {
  const { route, loading, openingProject, showStartupLoading, showProjectOpening } =
    useAppRouteController();

  return (
    <TooltipProvider>
      <AppShell>
        <div className="relative h-full" aria-busy={loading || openingProject}>
          {loading ? (
            showStartupLoading ? (
              <WelcomeLoadingState />
            ) : (
              <section className="h-full bg-canvas" aria-label="Starting Cinesim" />
            )
          ) : route === "settings" ? (
            <Settings />
          ) : route === "project" ? (
            <Workspace />
          ) : (
            <Welcome />
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
