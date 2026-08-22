import { useState } from "react";
import { Clapperboard, FolderOpen, Sparkles } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { DesktopProjectSession } from "../../shared/api";

interface WelcomeProps {
  onOpen: (session: DesktopProjectSession) => void;
}

export function Welcome({ onOpen }: WelcomeProps) {
  const [name, setName] = useState("Untitled film");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const session = await window.cinesim.createProject(name);
      if (session) onOpen(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create project");
    }
    setBusy(false);
  }

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const session = await window.cinesim.openProject();
      if (session) onOpen(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open project");
    }
    setBusy(false);
  }

  return (
    <main className="relative grid h-screen place-items-center overflow-hidden bg-canvas text-primary">
      <section className="relative w-[620px] rounded-2xl border border-border bg-panel/90 p-10 shadow-2xl shadow-black/20 backdrop-blur-xl">
        <div className="mb-9 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-accent text-on-accent shadow-lg">
            <Clapperboard size={22} strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-ui-lg font-semibold tracking-tight">Cinesim</h1>
            <p className="text-ui text-secondary">A creative workspace for people and agents</p>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <label className="grid gap-1.5">
            <span className="text-ui-xs font-medium uppercase tracking-[0.12em] text-muted">
              New project
            </span>
            <input
              className="h-10 rounded-lg border border-border bg-panel-muted px-3 text-ui outline-none transition focus:border-border-strong focus:ring-2 focus:ring-focus"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void create()}
            />
          </label>
          <Button
            className="mt-[21px] h-10"
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            <Sparkles size={15} /> Create project
          </Button>
        </div>
        <div className="my-7 flex items-center gap-3 text-ui-xs uppercase tracking-[0.18em] text-muted before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
          or
        </div>
        <Button className="h-11 w-full" onClick={() => void open()} disabled={busy}>
          <FolderOpen size={16} /> Open an existing Cinesim project
        </Button>
        {error && (
          <p className="mt-4 rounded-md border border-border-strong bg-surface p-2.5 text-ui text-primary">
            {error}
          </p>
        )}
        <p className="mt-8 text-center text-ui-xs text-muted">
          Canonical edits are written to cinesim.json + .cinesim/
        </p>
      </section>
    </main>
  );
}
