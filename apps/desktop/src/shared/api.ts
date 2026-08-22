import type { CommandResult, EditorCommand, Project, ProjectSettings } from "@cinesim/core";

export interface DesktopProjectSession {
  directory: string;
  project: Project;
  settings: ProjectSettings;
  canUndo: boolean;
  canRedo: boolean;
}

export interface RecentProject {
  name: string;
  directory: string;
}

export interface ProjectViewState {
  openSequenceIds: string[];
  activeTab: string;
}

export interface DesktopAppState {
  version: 1;
  recentProjects: RecentProject[];
  projectViews: Record<string, ProjectViewState>;
}

export interface DesktopApi {
  createProject(name: string): Promise<DesktopProjectSession | null>;
  openProject(): Promise<DesktopProjectSession | null>;
  openRecentProject(directory: string): Promise<DesktopProjectSession>;
  importMedia(): Promise<DesktopProjectSession | null>;
  execute(
    command: EditorCommand,
  ): Promise<{ session: DesktopProjectSession; result: Omit<CommandResult, "project"> }>;
  undo(): Promise<DesktopProjectSession>;
  redo(): Promise<DesktopProjectSession>;
  save(): Promise<DesktopProjectSession>;
  revealProject(): Promise<void>;
  getSession(): Promise<DesktopProjectSession | null>;
  getAppState(): Promise<DesktopAppState>;
  setProjectView(view: ProjectViewState): Promise<DesktopAppState>;
  onCloseActiveTab(callback: () => void): () => void;
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    cinesim: DesktopApi;
  }
}
