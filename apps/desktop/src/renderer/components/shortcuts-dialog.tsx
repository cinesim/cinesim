import { X } from "lucide-react";

interface ShortcutsDialogProps {
  open: boolean;
  isMac: boolean;
  onClose: () => void;
}

interface ShortcutRow {
  label: string;
  keys: string;
  scope?: string;
}

export function ShortcutHint({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border-strong bg-panel-muted px-1.5 py-0.5 text-[10px] font-medium text-muted shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({ open, isMac, onClose }: ShortcutsDialogProps) {
  if (!open) return null;

  const command = isMac ? "⌘" : "Ctrl+";
  const groups: Array<{ title: string; shortcuts: ShortcutRow[] }> = [
    {
      title: "Navigation",
      shortcuts: [
        { label: "Go Home", keys: `${command}⇧H` },
        { label: "Toggle left sidebar", keys: `${command}B` },
        ...(isMac ? [{ label: "Toggle agents sidebar", keys: "⌥⌘B", scope: "Project" }] : []),
        { label: "Show keyboard shortcuts", keys: `${command}/` },
      ],
    },
    {
      title: "Projects",
      shortcuts: [
        { label: "Open project", keys: `${command}O`, scope: "Home" },
        { label: "Open recent project", keys: `${command}1–9`, scope: "Home" },
      ],
    },
    {
      title: "Media and tabs",
      shortcuts: [
        { label: "Import media", keys: `${command}I`, scope: "Media" },
        { label: "Close active timeline", keys: `${command}W`, scope: "Timeline" },
      ],
    },
  ];

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-6">
      <button
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
      />
      <dialog
        open
        className="relative m-0 w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-panel p-0 text-primary shadow-2xl shadow-black/40"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <header className="flex h-12 items-center border-b border-border px-4">
          <h2 id="shortcuts-title" className="text-ui font-semibold text-primary">
            Keyboard shortcuts
          </h2>
          <button
            className="ml-auto grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary"
            aria-label="Close keyboard shortcuts"
            autoFocus
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        <div className="grid gap-5 p-4">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                {group.title}
              </h3>
              <div className="grid gap-0.5">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex min-h-9 items-center gap-3 px-1">
                    <span className="min-w-0 flex-1 text-ui text-secondary">
                      {shortcut.label}
                      {shortcut.scope && (
                        <span className="ml-2 text-ui-xs text-muted">{shortcut.scope}</span>
                      )}
                    </span>
                    <ShortcutHint>{shortcut.keys}</ShortcutHint>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </dialog>
    </div>
  );
}
