import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Cloud,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownSelect,
  Field,
  FieldDescription,
  FieldLabel,
  FolderOpen,
  FolderSearch,
  FolderX,
  Input,
  Kbd,
  Notice,
  PreviewCard,
  Skeleton,
  Trash2,
  cn,
} from "@cinesim/ui";
import type {
  CreateProjectLocation,
  RecentProject,
  RecentProjectDetails,
} from "../../../shared/contracts";
import { formatByteCount } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import { GoogleMark } from "../account/account-ui";
import {
  LibraryGrid,
  LibraryList,
  LibraryListRow,
  LibraryToolbar,
  LibraryViewToggle,
  useLibraryView,
} from "../shared/library-card";
import { projectModifiedLabel, sortHomeProjects, type ProjectSort } from "./home-projects";

const PROJECT_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Last modified" },
  { value: "created", label: "Date created" },
  { value: "size", label: "Size" },
] as const;

const PROJECT_LIST_COLUMNS =
  "grid-cols-[minmax(220px,1.25fr)_110px_130px_130px_100px_minmax(220px,1fr)_64px]";

function storedSort(): ProjectSort {
  const value = localStorage.getItem("cinesim.home.sort");
  return value === "modified" || value === "created" || value === "size" ? value : "name";
}

function projectGradient(key: string): React.CSSProperties {
  let hash = 0;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  const hue = Math.abs(hash) % 360;
  const secondHue = (hue + 42 + ((hash >>> 8) % 74)) % 360;
  return {
    backgroundImage: `linear-gradient(to bottom, hsl(${hue}, 68%, 48%), hsl(${secondHue}, 68%, 27%))`,
  };
}

function projectSizeLabel(size: number | null | undefined): string {
  if (size === undefined) return "Calculating…";
  if (size === null) return "Unavailable";
  return formatByteCount(size);
}

function projectDateLabel(timestamp: number | null | undefined): string {
  if (timestamp === undefined) return "Loading…";
  if (timestamp === null) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);
}

function Shortcut({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <Kbd className={dark ? "text-white/80" : undefined}>{children}</Kbd>;
}

function ProjectContextMenu({
  project,
  opening,
  children,
  onForget,
  onTrash,
}: {
  project: RecentProject;
  opening: boolean;
  children: React.ReactElement;
  onForget: (directory: string) => void;
  onTrash: (directory: string) => void;
}) {
  return (
    <ContextMenu disabled={opening}>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56" positionerClassName="z-[90]">
        <ContextMenuItem onClick={() => onForget(project.directory)}>
          <FolderX size={14} /> Forget Project
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onTrash(project.directory)}>
          <Trash2 size={14} /> Move Project to Trash
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function shortcutModifier(platform: string): string {
  return platform === "darwin" ? "⌘" : "Ctrl+";
}

function projectShortcut(index: number, modifier: string, dark: boolean): React.ReactNode {
  if (index >= 9) return null;
  return <Shortcut dark={dark}>{`${modifier}${index + 1}`}</Shortcut>;
}

function ProjectCloudBadge({ kind }: { kind: RecentProject["kind"] }) {
  if (kind !== "cloud") return null;
  return (
    <Cloud
      size={22}
      strokeWidth={2.25}
      className="absolute left-3 top-3 text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.45)]"
      aria-label="Cloud project"
      title="Cloud project"
    />
  );
}

function ProjectStorageIcon({ kind }: { kind: RecentProject["kind"] }) {
  return kind === "cloud" ? <Cloud size={14} /> : <FolderOpen size={14} />;
}

function projectStorageLabel(kind: RecentProject["kind"]): string {
  return kind === "cloud" ? "Cloud" : "Local";
}

function ProjectCollection({
  count,
  view,
  grid,
  list,
}: {
  count: number;
  view: "grid" | "list";
  grid: React.ReactNode;
  list: React.ReactNode;
}) {
  if (count > 0) return view === "grid" ? grid : list;
  return (
    <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-border-strong bg-panel-muted px-6 text-center">
      <div>
        <FolderOpen className="mx-auto mb-3 text-muted" size={24} />
        <p className="text-ui font-medium text-primary">No projects yet</p>
        <p className="mt-1 text-ui-xs text-muted">Create a project or open one from this Mac.</p>
      </div>
    </div>
  );
}

function storageChoiceClass(selected: boolean): string {
  return selected ? "border-accent bg-accent/10" : "border-border bg-panel-muted";
}

function CloudProjectNotice({
  kind,
  signedIn,
  cloudUnavailable,
}: {
  kind: "cloud" | "local";
  signedIn: boolean;
  cloudUnavailable: boolean;
}) {
  if (kind === "cloud" && !signedIn)
    return <Notice size="default">Sign in is required before creating a cloud project.</Notice>;
  if (cloudUnavailable)
    return (
      <Notice size="default">
        Cloud projects are unavailable from the connected account service.
      </Notice>
    );
  return null;
}

function createButtonLabel(opening: boolean, kind: "cloud" | "local", signedIn: boolean): string {
  if (opening) return "Creating…";
  if (kind === "cloud" && !signedIn) return "Sign in to create";
  return "Create project";
}

function emailSignInVariant(googleSignIn: boolean): "primary" | "secondary" {
  return googleSignIn ? "secondary" : "primary";
}

export function Welcome() {
  const appState = useRendererStore((state) => state.appState);
  const opening = useRendererStore((state) => state.project.status === "opening");
  const account = useRendererStore((state) => state.account);
  const onCreate = useRendererStore((state) => state.createProject);
  const onSignIn = useRendererStore((state) => state.beginAccountSignIn);
  const onOpen = useRendererStore((state) => state.openProject);
  const onOpenRecent = useRendererStore((state) => state.openRecentProject);
  const onForgetProject = useRendererStore((state) => state.forgetProject);
  const onTrashProject = useRendererStore((state) => state.trashProject);
  const reportError = useRendererStore((state) => state.reportError);
  const [view, setView] = useLibraryView("cinesim.home.view");
  const [sort, setSort] = useState<ProjectSort>(storedSort);
  const [projectDetails, setProjectDetails] = useState<Record<string, RecentProjectDetails>>({});
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const newProjectNameRef = useRef<HTMLInputElement>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectKind, setNewProjectKind] = useState<"cloud" | "local">("local");
  const [createLocation, setCreateLocation] = useState<CreateProjectLocation | null>(null);
  const [choosingLocation, setChoosingLocation] = useState(false);
  const [cloudSignInOpen, setCloudSignInOpen] = useState(false);
  const [signInBusy, setSignInBusy] = useState<"email" | "google" | null>(null);
  const [trashTarget, setTrashTarget] = useState<string | null>(null);
  const modifier = shortcutModifier(window.cinesim.platform);

  const displayedProjects = useMemo(
    () => sortHomeProjects(appState.recentProjects, sort, projectDetails),
    [appState.recentProjects, projectDetails, sort],
  );

  const open = useCallback(async () => {
    if (opening) return;
    await onOpen();
  }, [onOpen, opening]);

  const openRecent = useCallback(
    async (directory: string) => {
      if (opening) return;
      await onOpenRecent(directory);
    },
    [onOpenRecent, opening],
  );

  const beginNewProject = useCallback(() => {
    if (opening) return;
    setNewProjectName("");
    setNewProjectKind("local");
    setCreateLocation(null);
    setNewProjectOpen(true);
  }, [opening]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      if (!command || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        if (!newProjectOpen) beginNewProject();
        return;
      }
      if (newProjectOpen || cloudSignInOpen || trashTarget !== null) return;
      if (key === "o") {
        event.preventDefault();
        void open();
      } else if (/^[1-9]$/.test(key)) {
        const project = displayedProjects[Number(key) - 1];
        if (project) {
          event.preventDefault();
          void openRecent(project.directory);
        }
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [
    beginNewProject,
    cloudSignInOpen,
    displayedProjects,
    newProjectOpen,
    open,
    openRecent,
    trashTarget,
  ]);

  useEffect(() => localStorage.setItem("cinesim.home.sort", sort), [sort]);

  useEffect(() => {
    const interval = window.setInterval(() => setRelativeTimeNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!newProjectOpen) return;
    const frame = requestAnimationFrame(() => newProjectNameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [newProjectOpen]);

  useEffect(() => {
    let active = true;
    void window.cinesim.project
      .getRecentDetails()
      .then((details) => {
        if (active) setProjectDetails(details);
      })
      .catch(() => {
        if (active) setProjectDetails({});
      });
    return () => {
      active = false;
    };
  }, [appState.recentProjects]);

  async function chooseLocation(): Promise<void> {
    if (choosingLocation || opening) return;
    setChoosingLocation(true);
    try {
      const location = await window.cinesim.project.chooseCreateLocation();
      if (location) setCreateLocation(location);
    } catch (caught) {
      reportError(caught instanceof Error ? caught.message : "The folder could not be selected");
    }
    setChoosingLocation(false);
  }

  async function create(): Promise<void> {
    if (!newProjectName.trim() || !createLocation || opening) return;
    if (newProjectKind === "cloud" && account.status !== "signed-in") {
      setCloudSignInOpen(true);
      return;
    }
    setNewProjectOpen(false);
    const result = await onCreate(newProjectName, newProjectKind, createLocation.token);
    if (!result.ok) {
      setCreateLocation(null);
    }
  }

  async function signIn(method: "email" | "google"): Promise<void> {
    setSignInBusy(method);
    const result = await onSignIn(method);
    setSignInBusy(null);
    if (result.ok) setCloudSignInOpen(false);
    else {
      reportError(result.error);
      setCloudSignInOpen(false);
    }
  }

  function projectGrid() {
    return (
      <LibraryGrid>
        {displayedProjects.map((project, index) => {
          const details = projectDetails[project.directory];
          return (
            <ProjectContextMenu
              key={project.directory}
              project={project}
              opening={opening}
              onForget={(directory) => void onForgetProject(directory)}
              onTrash={setTrashTarget}
            >
              <PreviewCard
                ariaLabel={`Open ${project.name}`}
                disabled={opening}
                variant="frameless"
                previewClassName="text-white"
                previewStyle={projectGradient(`${project.name}:${project.directory}`)}
                corner={projectShortcut(index, modifier, true)}
                preview={<ProjectCloudBadge kind={project.kind} />}
                onClick={() => void openRecent(project.directory)}
              >
                <p className="truncate text-ui font-medium text-primary">{project.name}</p>
                <p className="mt-0.5 text-ui-xs text-muted tabular-nums">
                  {projectModifiedLabel(details?.modifiedAt, relativeTimeNow)}
                </p>
              </PreviewCard>
            </ProjectContextMenu>
          );
        })}
      </LibraryGrid>
    );
  }

  function projectList() {
    return (
      <LibraryList
        columnsClassName={PROJECT_LIST_COLUMNS}
        minWidthClassName="min-w-[1120px]"
        headers={["Name", "Storage", "Modified", "Created", "Size", "Location", "Open"]}
      >
        {displayedProjects.map((project, index) => {
          const details = projectDetails[project.directory];
          return (
            <ProjectContextMenu
              key={project.directory}
              project={project}
              opening={opening}
              onForget={(directory) => void onForgetProject(directory)}
              onTrash={setTrashTarget}
            >
              <LibraryListRow
                columnsClassName={PROJECT_LIST_COLUMNS}
                disabled={opening}
                onClick={() => void openRecent(project.directory)}
              >
                <span className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                  <span
                    className="block aspect-video w-14 shrink-0 rounded border border-white/10"
                    style={projectGradient(`${project.name}:${project.directory}`)}
                  />
                  <span className="truncate font-medium text-primary">{project.name}</span>
                </span>
                <span className="flex items-center gap-1.5 px-3 py-2.5">
                  <ProjectStorageIcon kind={project.kind} />
                  {projectStorageLabel(project.kind)}
                </span>
                <span className="px-3 py-2.5 tabular-nums">
                  {projectDateLabel(details?.modifiedAt)}
                </span>
                <span className="px-3 py-2.5 tabular-nums">
                  {projectDateLabel(details?.createdAt)}
                </span>
                <span className="px-3 py-2.5 tabular-nums">
                  {projectSizeLabel(details?.sizeBytes)}
                </span>
                <span className="truncate px-3 py-2.5 text-muted">{project.directory}</span>
                <span className="px-3 py-2.5">
                  {projectShortcut(index, modifier, false) ?? "—"}
                </span>
              </LibraryListRow>
            </ProjectContextMenu>
          );
        })}
      </LibraryList>
    );
  }

  const projectToTrash = displayedProjects.find((project) => project.directory === trashTarget);
  const signedInCloudUnavailable =
    newProjectKind === "cloud" && account.status === "signed-in" && account.cloudStorage !== true;
  const canCreate =
    Boolean(newProjectName.trim() && createLocation) && !opening && !signedInCloudUnavailable;

  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas">
      <LibraryToolbar title="Projects" count={displayedProjects.length}>
        <div className="flex items-center gap-2 text-ui-xs text-muted">
          <span>Sort by</span>
          <DropdownSelect
            className="w-36"
            aria-label="Sort projects"
            options={PROJECT_SORT_OPTIONS}
            value={sort}
            onValueChange={setSort}
          />
        </div>
        <LibraryViewToggle label="Project view" view={view} onViewChange={setView} />
        <Button data-open-project disabled={opening} onClick={() => void open()}>
          Open project
          <Kbd className="ml-1">{modifier}O</Kbd>
        </Button>
        <Button variant="primary" disabled={opening} onClick={beginNewProject}>
          New project
          <Kbd className="ml-1">{modifier}N</Kbd>
        </Button>
      </LibraryToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <ProjectCollection
          count={displayedProjects.length}
          view={view}
          grid={projectGrid()}
          list={projectList()}
        />
      </div>

      <Dialog
        open={newProjectOpen}
        onOpenChange={(nextOpen) => {
          if (!opening) setNewProjectOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-lg">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
            </DialogHeader>
            <div className="space-y-5 p-5">
              <Field className="gap-2">
                <FieldLabel>Storage</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={cn(
                      "rounded-lg border p-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus",
                      storageChoiceClass(newProjectKind === "local"),
                    )}
                    aria-pressed={newProjectKind === "local"}
                    onClick={() => setNewProjectKind("local")}
                  >
                    <span className="flex items-center gap-2 text-ui font-medium text-primary">
                      <FolderOpen size={15} /> Local
                    </span>
                    <span className="mt-1 block text-ui-xs leading-4 text-muted">
                      Keep originals and project files on this Mac.
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-lg border p-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus",
                      storageChoiceClass(newProjectKind === "cloud"),
                    )}
                    aria-pressed={newProjectKind === "cloud"}
                    onClick={() => setNewProjectKind("cloud")}
                  >
                    <span className="flex items-center gap-2 text-ui font-medium text-primary">
                      <Cloud size={15} /> Cloud
                    </span>
                    <span className="mt-1 block text-ui-xs leading-4 text-muted">
                      Privately upload originals and keep local editing proxies.
                    </span>
                  </button>
                </div>
              </Field>

              <Field className="gap-2">
                <FieldLabel htmlFor="new-project-name">Project name</FieldLabel>
                <Input
                  ref={newProjectNameRef}
                  id="new-project-name"
                  value={newProjectName}
                  placeholder="Untitled project"
                  maxLength={120}
                  disabled={opening}
                  onChange={(event) => setNewProjectName(event.target.value)}
                />
              </Field>

              <Field className="gap-2">
                <FieldLabel htmlFor="new-project-location">Save to</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="new-project-location"
                    className="flex-1"
                    value={createLocation?.directory ?? ""}
                    placeholder="Choose a folder"
                    readOnly
                    title={createLocation?.directory}
                  />
                  <Button
                    type="button"
                    disabled={choosingLocation || opening}
                    onClick={() => void chooseLocation()}
                  >
                    <FolderSearch size={14} />
                    {choosingLocation ? "Choosing…" : "Choose…"}
                  </Button>
                </div>
                <FieldDescription>
                  Cinesim will create a project folder inside this location.
                </FieldDescription>
              </Field>

              <CloudProjectNotice
                kind={newProjectKind}
                signedIn={account.status === "signed-in"}
                cloudUnavailable={signedInCloudUnavailable}
              />
            </div>
            <DialogFooter className="border-t border-border p-4">
              <Button
                type="button"
                variant="ghost"
                disabled={opening}
                onClick={() => setNewProjectOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!canCreate}>
                {createButtonLabel(opening, newProjectKind, account.status === "signed-in")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={cloudSignInOpen} onOpenChange={setCloudSignInOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in for cloud projects</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 p-4">
            <DialogDescription>
              Cloud projects privately upload their original media and keep a local editing proxy.
              Local projects remain available without an account.
            </DialogDescription>
            <div className="space-y-2">
              {account.googleSignIn && (
                <Button
                  className="w-full"
                  variant="primary"
                  disabled={signInBusy !== null}
                  onClick={() => void signIn("google")}
                >
                  <GoogleMark className="size-4" />
                  {signInBusy === "google" ? "Opening Google…" : "Continue with Google"}
                </Button>
              )}
              <Button
                className="w-full"
                variant={emailSignInVariant(account.googleSignIn)}
                disabled={!account.serviceAvailable || signInBusy !== null}
                onClick={() => void signIn("email")}
              >
                {signInBusy === "email" ? "Opening browser…" : "Sign in with email"}
              </Button>
            </div>
            {!account.serviceAvailable && (
              <Notice size="default">
                {account.detail ?? "The account service is unavailable."}
              </Notice>
            )}
          </div>
          <DialogFooter className="border-t border-border p-4">
            <Button variant="ghost" onClick={() => setCloudSignInOpen(false)}>
              Back to project setup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={trashTarget !== null}
        onOpenChange={(nextOpen) => !nextOpen && setTrashTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move project to Trash</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <DialogDescription>
              Move “{projectToTrash?.name ?? "this project"}” and its entire folder to macOS Trash?
              External source media stays in place, but any media or other files inside the project
              folder will move with it.
            </DialogDescription>
          </div>
          <DialogFooter className="border-t border-border p-4">
            <Button variant="ghost" onClick={() => setTrashTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!trashTarget) return;
                const directory = trashTarget;
                setTrashTarget(null);
                void onTrashProject(directory);
              }}
            >
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function WelcomeLoadingState() {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-canvas"
      aria-busy="true"
      aria-label="Loading projects"
    >
      <LibraryToolbar title={<Skeleton className="h-4 w-20" tone="active" />}>
        <div className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="h-8 w-36 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-32 rounded-md" />
          <Skeleton className="h-8 w-32 rounded-md" tone="active" />
        </div>
      </LibraryToolbar>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <LibraryGrid>
          {Array.from({ length: 4 }, (_, index) => (
            <PreviewCard
              key={`project-loading-${index}`}
              variant="frameless"
              previewClassName="media-thumbnail"
              preview={<Skeleton className="absolute inset-0 rounded-none" />}
            >
              <div className="space-y-1.5" aria-hidden="true">
                <Skeleton className="block h-3.5 w-3/5" tone="active" />
                <Skeleton className="block h-3 w-2/5" />
              </div>
            </PreviewCard>
          ))}
        </LibraryGrid>
      </div>
    </section>
  );
}
