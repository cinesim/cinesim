import { useDelayedBusy } from "./use-delayed-busy";
import { sessionFromLifecycle } from "../store/renderer-store";
import type { Destination } from "../store/renderer-store";
import { useRendererStore } from "../store/renderer-store-context";

export function activeAppRoute(destination: Destination, projectAvailable: boolean): Destination {
  return destination === "project" && !projectAvailable ? "home" : destination;
}

export function useAppRouteController() {
  const project = useRendererStore((state) => state.project);
  const destination = useRendererStore((state) => state.destination);
  const loading = project.status === "booting";
  const openingProject = project.status === "opening";
  return {
    route: activeAppRoute(destination, sessionFromLifecycle(project) !== null),
    loading,
    openingProject,
    showStartupLoading: useDelayedBusy(loading),
  };
}
