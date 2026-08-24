import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Clapperboard, Plus } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { DesktopAppState, DesktopProjectSession } from "../../shared/api";
import type { ActionResult } from "../store/renderer-store";
import { LibraryCard, LibraryGrid } from "./library-card";

interface WelcomeProps {
  appState: DesktopAppState;
  error: string | null;
  loading: boolean;
  opening: boolean;
  onCreate: (name: string) => Promise<ActionResult<DesktopProjectSession | null>>;
  onOpen: () => Promise<ActionResult<DesktopProjectSession | null>>;
  onOpenRecent: (directory: string) => Promise<ActionResult<DesktopProjectSession>>;
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

function Shortcut({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <kbd
      className={
        dark
          ? "rounded border border-white/20 bg-black/20 px-1.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm"
          : "rounded border border-border bg-panel-muted px-1.5 py-0.5 text-[10px] font-medium text-muted shadow-sm"
      }
    >
      {children}
    </kbd>
  );
}

export function Welcome({
  appState,
  error,
  loading,
  opening,
  onCreate,
  onOpen,
  onOpenRecent,
}: WelcomeProps) {
  const [name, setName] = useState("");
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
              <kbd className="ml-1 rounded border border-border-strong bg-panel-muted px-1 py-0.5 text-[10px] font-medium text-muted">
                {modifier}O
              </kbd>
            </Button>
          </div>
        </div>

        <LibraryGrid>
          <LibraryCard
            badge="New project"
            previewClassName="media-thumbnail text-secondary"
            preview={
              <span className="grid size-12 place-items-center rounded-xl bg-accent text-on-accent shadow-sm">
                <Plus size={21} />
              </span>
            }
          >
            <div className="flex min-h-11 items-center gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Project name</span>
                <input
                  className="h-8 w-full min-w-0 rounded-md border border-border bg-panel-muted px-2.5 text-ui outline-none transition-colors placeholder:text-muted focus:border-border-strong focus:ring-2 focus:ring-focus"
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
          </LibraryCard>

          {appState.recentProjects.map((project, index) => (
            <LibraryCard
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
                  <Clapperboard className="relative drop-shadow-md" size={25} strokeWidth={1.6} />
                </>
              }
              onClick={() => void openRecent(project.directory)}
            >
              <p className="truncate text-ui font-medium text-primary">{project.name}</p>
              <p className="mt-1 truncate text-ui-xs text-muted">{project.directory}</p>
            </LibraryCard>
          ))}
        </LibraryGrid>

        {error && (
          <p className="mt-4 rounded-lg border border-border-strong bg-panel px-4 py-3 text-ui text-primary">
            {error}
          </p>
        )}
      </div>
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
          <span className="h-4 w-20 animate-pulse rounded bg-surface-active" aria-hidden="true" />
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-3 w-12 animate-pulse rounded bg-surface" />
            <span className="h-8 w-28 animate-pulse rounded-md bg-surface-active" />
          </div>
        </div>

        <LibraryGrid>
          <LibraryCard
            previewClassName="media-thumbnail"
            preview={
              <span
                className="size-12 animate-pulse rounded-xl bg-surface-active"
                aria-hidden="true"
              />
            }
          >
            <div className="flex min-h-11 items-center gap-2" aria-hidden="true">
              <span className="h-8 min-w-0 flex-1 animate-pulse rounded-md bg-surface" />
              <span className="h-8 w-14 animate-pulse rounded-md bg-surface-active" />
            </div>
          </LibraryCard>

          {Array.from({ length: 4 }, (_, index) => (
            <LibraryCard
              key={`project-loading-${index}`}
              previewClassName="media-thumbnail"
              preview={
                <span className="absolute inset-0 animate-pulse bg-surface" aria-hidden="true" />
              }
            >
              <div className="space-y-2" aria-hidden="true">
                <span className="block h-3.5 w-3/5 animate-pulse rounded bg-surface-active" />
                <span className="block h-3 w-4/5 animate-pulse rounded bg-surface" />
              </div>
            </LibraryCard>
          ))}
        </LibraryGrid>
      </div>
    </section>
  );
}
