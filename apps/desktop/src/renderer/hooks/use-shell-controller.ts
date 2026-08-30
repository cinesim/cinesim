import { useCallback } from "react";
import { sessionFromLifecycle } from "../store/renderer-store";
import type { SettingsSection } from "../store/renderer-store";
import { useRendererStore } from "../store/renderer-store-context";

export function useShellController() {
  const project = useRendererStore((state) => state.project);
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const destination = useRendererStore((state) => state.destination);
  const projectSection = useRendererStore((state) => state.projectSection);
  const auxiliaryMode = useRendererStore((state) => state.auxiliaryMode);
  const navigate = useRendererStore((state) => state.navigate);
  const setSettingsSection = useRendererStore((state) => state.setSettingsSection);
  const showProjectSection = useRendererStore((state) => state.showProjectSection);
  const setAuxiliaryMode = useRendererStore((state) => state.setAuxiliaryMode);
  const goHome = useCallback(() => navigate("home"), [navigate]);
  const openSettings = useCallback(
    (section: SettingsSection) => {
      setSettingsSection(section);
      navigate("settings");
    },
    [navigate, setSettingsSection],
  );
  return {
    auxiliaryMode: destination === "project" ? auxiliaryMode : null,
    destination,
    goHome,
    interactionLocked: project.status === "opening",
    openSettings,
    projectSection,
    session,
    setAuxiliaryMode,
    showProjectSection,
    title:
      destination === "settings"
        ? "Settings"
        : destination === "project" && session
          ? session.project.name
          : "Home",
  };
}
