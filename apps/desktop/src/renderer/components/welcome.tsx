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
    <main className="relative grid h-screen place-items-center overflow-hidden bg-[#09090b] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_25%,rgba(124,58,237,0.14),transparent_38%)]" />
      <section className="relative w-[620px] rounded-2xl border border-white/10 bg-zinc-950/80 p-10 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <div className="mb-9 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-violet-500 text-white shadow-lg shadow-violet-500/20">
            <Clapperboard size={22} strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Cinesim</h1>
            <p className="text-xs text-zinc-500">A creative workspace for people and agents</p>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <label className="grid gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">
              New project
            </span>
            <input
              className="h-10 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm outline-none transition focus:border-violet-400/50 focus:ring-2 focus:ring-violet-500/15"
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
        <div className="my-7 flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-zinc-700 before:h-px before:flex-1 before:bg-white/[0.07] after:h-px after:flex-1 after:bg-white/[0.07]">
          or
        </div>
        <Button className="h-11 w-full" onClick={() => void open()} disabled={busy}>
          <FolderOpen size={16} /> Open an existing Cinesim project
        </Button>
        {error && (
          <p className="mt-4 rounded-md border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-300">
            {error}
          </p>
        )}
        <p className="mt-8 text-center text-[11px] text-zinc-600">
          Canonical edits are written to cinesim.json + .cinesim/
        </p>
      </section>
    </main>
  );
}
