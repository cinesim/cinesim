import { TooltipProvider } from "@cinesim/ui";
import { Welcome, WelcomeLoadingState } from "./components/home/welcome";
import { Settings } from "./components/settings/settings";
import { AppShell } from "./components/shell/app-shell";
import { Workspace } from "./components/workspace/workspace";
import { useAppRouteController } from "./hooks/use-app-route-controller";

export function App() {
  const { route, loading, openingProject, showStartupLoading } = useAppRouteController();

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
        </div>
      </AppShell>
    </TooltipProvider>
  );
}
