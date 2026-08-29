import { useDelayedBusy } from "./use-delayed-busy";
import {
  cutLayoutFromState,
  editorLayoutFromState,
  sessionFromLifecycle,
} from "../store/renderer-store";
import { useRendererStore } from "../store/renderer-store-context";

export function useAppController() {
  const project = useRendererStore((state) => state.project);
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const destination = useRendererStore((state) => state.destination);
  const controller = {
    project,
    session,
    appState: useRendererStore((state) => state.appState),
    destination,
    projectSection: useRendererStore((state) => state.projectSection),
    activeSequenceId: useRendererStore((state) => state.activeSequenceId),
    mediaPoolOpen: useRendererStore((state) => state.mediaPoolOpen),
    inspectorOpen: useRendererStore((state) => state.inspectorOpen),
    notesOpen: useRendererStore((state) => state.notesOpen),
    settingsSection: useRendererStore((state) => state.settingsSection),
    account: useRendererStore((state) => state.account),
    accountHydrated: useRendererStore((state) => state.accountHydrated),
    auxiliaryMode: useRendererStore((state) => state.auxiliaryMode),
    error: useRendererStore((state) => state.operationError),
    editorLayout: useRendererStore(editorLayoutFromState),
    cutLayout: useRendererStore(cutLayoutFromState),
    navigate: useRendererStore((state) => state.navigate),
    showProjectSection: useRendererStore((state) => state.showProjectSection),
    showTimeline: useRendererStore((state) => state.showTimeline),
    setSettingsSection: useRendererStore((state) => state.setSettingsSection),
    beginAccountSignIn: useRendererStore((state) => state.beginAccountSignIn),
    signOutAccount: useRendererStore((state) => state.signOutAccount),
    setAuxiliaryMode: useRendererStore((state) => state.setAuxiliaryMode),
    togglePanel: useRendererStore((state) => state.togglePanel),
    openProject: useRendererStore((state) => state.openProject),
    openRecentProject: useRendererStore((state) => state.openRecentProject),
    createProject: useRendererStore((state) => state.createProject),
    forgetProject: useRendererStore((state) => state.forgetProject),
    trashProject: useRendererStore((state) => state.trashProject),
  };
  const loading = project.status === "booting";
  const openingProject = project.status === "opening";
  return {
    ...controller,
    loading,
    openingProject,
    showStartupLoading: useDelayedBusy(loading),
    showProjectOpening: useDelayedBusy(openingProject),
    title:
      destination === "settings"
        ? "Settings"
        : destination === "project" && session
          ? session.project.name
          : "Home",
  };
}
