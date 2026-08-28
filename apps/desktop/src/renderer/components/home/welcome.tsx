import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderOpen,
  FolderX,
  Info,
  Trash2,
} from "@cinesim/ui";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Kbd,
  Notice,
  PreviewCard,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cinesim/ui";
import type {
  AccountSnapshot,
  DesktopAppState,
  DesktopProjectSession,
  RecentProject,
} from "../../../shared/api";
import { formatByteCount } from "../../lib/format";
import type { ActionResult } from "../../store/renderer-store";
import { LibraryGrid } from "../shared/library-card";
import { GoogleMark } from "../account/account-ui";

interface WelcomeProps {
  appState: DesktopAppState;
  error: string | null;
  loading: boolean;
  opening: boolean;
  account: AccountSnapshot;
  onCreate: (
    name: string,
    kind: "local" | "cloud",
  ) => Promise<ActionResult<DesktopProjectSession | null>>;
  onSignIn: (method: "email" | "google") => Promise<ActionResult<void>>;
  onOpen: () => Promise<ActionResult<DesktopProjectSession | null>>;
  onOpenRecent: (directory: string) => Promise<ActionResult<DesktopProjectSession>>;
  onForgetProject: (directory: string) => Promise<ActionResult<DesktopAppState>>;
  onTrashProject: (directory: string) => Promise<ActionResult<DesktopAppState>>;
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
  if (size === undefined) return "Calculating project size…";
  if (size === null) return "Project size unavailable";
  return `${formatByteCount(size)} project files`;
}

function Shortcut({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <Kbd className={dark ? "text-white/80" : undefined}>{children}</Kbd>;
}

function ProjectGroup({
  kind,
  count,
  open,
  onToggle,
  children,
}: {
  kind: "cloud" | "local";
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const label = kind === "cloud" ? "Cloud" : "Local";
  return (
    <section className="mt-5" aria-labelledby={`${kind}-projects-heading`}>
      <div className="mb-3 flex items-center gap-1.5">
        <button
          className="flex h-8 items-center gap-2 rounded-md px-1.5 text-ui font-semibold text-primary hover:bg-surface"
          aria-expanded={open}
          aria-controls={`${kind}-projects`}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {kind === "cloud" ? <Cloud size={14} /> : <FolderOpen size={14} />}
          <span id={`${kind}-projects-heading`}>{label}</span>
          <span className="text-ui-xs font-normal tabular-nums text-muted">{count}</span>
        </button>
        {kind === "cloud" && (
          <Tooltip>
            <TooltipTrigger
              className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
              aria-label="About cloud projects"
            >
              <Info size={14} />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs leading-5">
              Cloud projects require an account and upload every imported original privately.
              Canonical project files and editing proxies stay on this Mac.
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {open && (
        <div id={`${kind}-projects`}>
          <LibraryGrid>{children}</LibraryGrid>
        </div>
      )}
    </section>
  );
}

export function Welcome({
  appState,
  error,
  loading,
  opening,
  account,
  onCreate,
  onSignIn,
  onOpen,
  onOpenRecent,
  onForgetProject,
  onTrashProject,
}: WelcomeProps) {
  const [names, setNames] = useState({ cloud: "", local: "" });
  const [cloudOpen, setCloudOpen] = useState(
    () => localStorage.getItem("cinesim.home.cloudOpen") !== "false",
  );
  const [localOpen, setLocalOpen] = useState(
    () => localStorage.getItem("cinesim.home.localOpen") !== "false",
  );
  const [cloudSignInOpen, setCloudSignInOpen] = useState(false);
  const [signInBusy, setSignInBusy] = useState<"email" | "google" | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [projectSizes, setProjectSizes] = useState<Record<string, number | null>>({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    directory: string;
  } | null>(null);
  const [trashTarget, setTrashTarget] = useState<string | null>(null);
  const modifier = window.cinesim.platform === "darwin" ? "⌘" : "Ctrl+";

  const { cloudProjects, localProjects, displayedProjects } = useMemo(() => {
    const cloud = appState.recentProjects.filter((project) => project.kind === "cloud");
    const local = appState.recentProjects.filter((project) => project.kind === "local");
    return { cloudProjects: cloud, localProjects: local, displayedProjects: [...cloud, ...local] };
  }, [appState.recentProjects]);

  async function create(kind: "cloud" | "local") {
    const name = names[kind];
    if (!name.trim() || opening) return;
    if (kind === "cloud" && account.status !== "signed-in") {
      setCloudSignInOpen(true);
      return;
    }
    await onCreate(name, kind);
  }

  async function signIn(method: "email" | "google"): Promise<void> {
    setSignInBusy(method);
    setSignInError(null);
    const result = await onSignIn(method);
    setSignInBusy(null);
    if (result.ok) setCloudSignInOpen(false);
    else setSignInError(result.error);
  }

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

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      if (!command || event.altKey) return;
      const key = event.key.toLowerCase();
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
  }, [displayedProjects, open, openRecent]);

  useEffect(() => localStorage.setItem("cinesim.home.cloudOpen", String(cloudOpen)), [cloudOpen]);
  useEffect(() => localStorage.setItem("cinesim.home.localOpen", String(localOpen)), [localOpen]);

  useEffect(() => {
    let active = true;
    void window.cinesim
      .getRecentProjectSizes()
      .then((sizes) => {
        if (active) setProjectSizes(sizes);
      })
      .catch(() => {
        if (active) setProjectSizes({});
      });
    return () => {
      active = false;
    };
  }, [appState.recentProjects]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-project-context-menu]")
      )
        setContextMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, []);

  const projectToTrash = displayedProjects.find((project) => project.directory === trashTarget);

  function newProjectCard(kind: "cloud" | "local") {
    const signedOutCloud = kind === "cloud" && account.status !== "signed-in";
    return (
      <PreviewCard previewClassName="media-thumbnail text-secondary" preview={null}>
        <div className="flex min-h-11 items-center gap-2">
          <label className="min-w-0 flex-1" htmlFor={`new-${kind}-project-name`}>
            <span className="sr-only">New {kind} project name</span>
            <Input
              id={`new-${kind}-project-name`}
              className="w-full"
              size="sm"
              surface="muted"
              value={names[kind]}
              placeholder={`Name a ${kind} project`}
              maxLength={120}
              disabled={opening}
              onChange={(event) =>
                setNames((current) => ({ ...current, [kind]: event.target.value }))
              }
              onKeyDown={(event) => event.key === "Enter" && void create(kind)}
            />
          </label>
          <Button
            variant="primary"
            disabled={opening || !names[kind].trim()}
            onClick={() => void create(kind)}
          >
            {signedOutCloud ? "Sign in" : "Start"} <ArrowRight size={14} />
          </Button>
        </div>
      </PreviewCard>
    );
  }

  function projectCards(projects: RecentProject[], shortcutOffset: number) {
    return projects.map((project, index) => {
      const shortcutIndex = shortcutOffset + index;
      return (
        <PreviewCard
          key={project.directory}
          ariaLabel={`Open ${project.name}`}
          title={project.directory}
          disabled={opening}
          previewClassName="text-white"
          previewStyle={projectGradient(`${project.name}:${project.directory}`)}
          corner={
            shortcutIndex < 9 ? (
              <Shortcut dark>{`${modifier}${shortcutIndex + 1}`}</Shortcut>
            ) : undefined
          }
          preview={null}
          onClick={() => void openRecent(project.directory)}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              directory: project.directory,
            });
          }}
        >
          <p className="truncate text-ui font-medium text-primary">{project.name}</p>
          <p className="mt-1 truncate text-ui-xs text-muted">{project.directory}</p>
          <p className="mt-0.5 text-ui-xs text-muted tabular-nums">
            {projectSizeLabel(projectSizes[project.directory])}
          </p>
        </PreviewCard>
      );
    });
  }

  if (loading) return <WelcomeLoadingState />;

  return (
    <section className="h-full overflow-y-auto bg-canvas px-5 py-6">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-ui font-semibold text-primary">Projects</h1>
          <Button data-open-project onClick={() => void open()}>
            Open project
            <Kbd className="ml-1">{modifier}O</Kbd>
          </Button>
        </div>

        <ProjectGroup
          kind="cloud"
          count={cloudProjects.length}
          open={cloudOpen}
          onToggle={() => setCloudOpen((open) => !open)}
        >
          {newProjectCard("cloud")}
          {projectCards(cloudProjects, 0)}
        </ProjectGroup>

        <ProjectGroup
          kind="local"
          count={localProjects.length}
          open={localOpen}
          onToggle={() => setLocalOpen((open) => !open)}
        >
          {newProjectCard("local")}
          {projectCards(localProjects, cloudProjects.length)}
        </ProjectGroup>

        {error && (
          <Notice
            className="mt-4 rounded-lg border-border-strong bg-panel px-4 py-3 text-primary"
            size="default"
          >
            {error}
          </Notice>
        )}
      </div>

      {contextMenu && (
        <div
          data-project-context-menu
          role="menu"
          className="fixed z-[90] w-56 rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl shadow-black/30"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 240),
            top: Math.min(contextMenu.y, window.innerHeight - 112),
          }}
        >
          <button
            role="menuitem"
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-ui hover:bg-surface"
            onClick={() => {
              void onForgetProject(contextMenu.directory);
              setContextMenu(null);
            }}
          >
            <FolderX size={14} /> Forget Project
          </button>
          <button
            role="menuitem"
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-ui hover:bg-surface"
            onClick={() => {
              setTrashTarget(contextMenu.directory);
              setContextMenu(null);
            }}
          >
            <Trash2 size={14} /> Move Project to Trash
          </button>
        </div>
      )}

      <Dialog
        open={cloudSignInOpen}
        onOpenChange={(open) => {
          setCloudSignInOpen(open);
          if (!open) setSignInError(null);
        }}
      >
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
                variant={account.googleSignIn ? "secondary" : "primary"}
                disabled={!account.serviceAvailable || signInBusy !== null}
                onClick={() => void signIn("email")}
              >
                {signInBusy === "email" ? "Opening browser…" : "Sign in with email"}
              </Button>
            </div>
            {(signInError || !account.serviceAvailable) && (
              <Notice size="default">
                {signInError ?? account.detail ?? "The account service is unavailable."}
              </Notice>
            )}
          </div>
          <DialogFooter className="border-t border-border p-4">
            <Button variant="ghost" onClick={() => setCloudSignInOpen(false)}>
              Continue locally
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={trashTarget !== null} onOpenChange={(open) => !open && setTrashTarget(null)}>
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
      className="h-full overflow-y-auto bg-canvas px-5 py-6"
      aria-busy="true"
      aria-label="Loading projects"
    >
      <div>
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-4 w-20" tone="active" />
          <div className="flex items-center gap-3" aria-hidden="true">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-8 w-28 rounded-md" tone="active" />
          </div>
        </div>

        <LibraryGrid>
          <PreviewCard
            previewClassName="media-thumbnail"
            preview={<Skeleton className="size-12 rounded-xl" tone="active" />}
          >
            <div className="flex min-h-11 items-center gap-2" aria-hidden="true">
              <Skeleton className="h-8 min-w-0 flex-1 rounded-md" />
              <Skeleton className="h-8 w-14 rounded-md" tone="active" />
            </div>
          </PreviewCard>

          {Array.from({ length: 4 }, (_, index) => (
            <PreviewCard
              key={`project-loading-${index}`}
              previewClassName="media-thumbnail"
              preview={<Skeleton className="absolute inset-0 rounded-none" />}
            >
              <div className="space-y-2" aria-hidden="true">
                <Skeleton className="block h-3.5 w-3/5" tone="active" />
                <Skeleton className="block h-3 w-4/5" />
              </div>
            </PreviewCard>
          ))}
        </LibraryGrid>
      </div>
    </section>
  );
}
