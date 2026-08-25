import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FolderX, Plus, Trash2 } from "lucide-react";
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
} from "@cinesim/ui";
import type { DesktopAppState, DesktopProjectSession } from "../../../shared/api";
import { formatByteCount } from "../../lib/format";
import type { ActionResult } from "../../store/renderer-store";
import { LibraryGrid } from "../shared/library-card";

interface WelcomeProps {
  appState: DesktopAppState;
  error: string | null;
  loading: boolean;
  opening: boolean;
  onCreate: (name: string) => Promise<ActionResult<DesktopProjectSession | null>>;
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
  const angle = 115 + ((hash >>> 16) % 70);
  return {
    backgroundImage: `radial-gradient(circle at 24% 18%, hsla(${secondHue}, 92%, 76%, 0.7), transparent 38%), linear-gradient(${angle}deg, hsl(${hue}, 68%, 48%), hsl(${secondHue}, 68%, 27%))`,
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

export function Welcome({
  appState,
  error,
  loading,
  opening,
  onCreate,
  onOpen,
  onOpenRecent,
  onForgetProject,
  onTrashProject,
}: WelcomeProps) {
  const [name, setName] = useState("");
  const [projectSizes, setProjectSizes] = useState<Record<string, number | null>>({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    directory: string;
  } | null>(null);
  const [trashTarget, setTrashTarget] = useState<string | null>(null);
  const modifier = window.cinesim.platform === "darwin" ? "⌘" : "Ctrl+";

  async function create() {
    if (!name.trim() || opening) return;
    await onCreate(name);
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
        const project = appState.recentProjects[Number(key) - 1];
        if (project) {
          event.preventDefault();
          void openRecent(project.directory);
        }
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [appState.recentProjects, open, openRecent]);

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

  const projectToTrash = appState.recentProjects.find(
    (project) => project.directory === trashTarget,
  );

  if (loading) return <WelcomeLoadingState />;

  return (
    <section className="h-full overflow-y-auto bg-canvas px-5 py-6">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-ui font-semibold text-primary">Projects</h1>
          <div className="flex items-center gap-3">
            <span className="text-ui-xs text-muted">{appState.recentProjects.length} saved</span>
            <Button data-open-project onClick={() => void open()}>
              Open project
              <Kbd className="ml-1">{modifier}O</Kbd>
            </Button>
          </div>
        </div>

        <LibraryGrid>
          <PreviewCard
            previewClassName="media-thumbnail text-secondary"
            preview={
              <span className="grid size-12 place-items-center rounded-xl bg-accent text-on-accent shadow-sm">
                <Plus size={21} />
              </span>
            }
          >
            <div className="flex min-h-11 items-center gap-2">
              <label className="min-w-0 flex-1" htmlFor="new-project-name">
                <span className="sr-only">Project name</span>
                <Input
                  id="new-project-name"
                  className="w-full"
                  size="sm"
                  surface="muted"
                  value={name}
                  placeholder="Name your project"
                  maxLength={120}
                  disabled={opening}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void create()}
                />
              </label>
              <Button
                variant="primary"
                disabled={opening || !name.trim()}
                onClick={() => void create()}
              >
                Start <ArrowRight size={14} />
              </Button>
            </div>
          </PreviewCard>

          {appState.recentProjects.map((project, index) => (
            <PreviewCard
              key={project.directory}
              ariaLabel={`Open ${project.name}`}
              title={project.directory}
              disabled={opening}
              previewClassName="text-white"
              previewStyle={projectGradient(`${project.name}:${project.directory}`)}
              corner={index < 9 ? <Shortcut dark>{`${modifier}${index + 1}`}</Shortcut> : undefined}
              preview={
                <>
                  <span className="absolute -bottom-16 -right-8 size-40 rounded-full border border-white/20" />
                  <span className="absolute -left-10 -top-16 size-40 rounded-full bg-white/10" />
                </>
              }
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
          ))}
        </LibraryGrid>

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

function WelcomeLoadingState() {
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
