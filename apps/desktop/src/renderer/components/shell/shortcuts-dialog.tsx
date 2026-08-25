import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, Kbd, SearchField } from "@cinesim/ui";

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

export const ShortcutHint = Kbd;

export function ShortcutsDialog({ open, isMac, onClose }: ShortcutsDialogProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

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
      title: "Project sections",
      shortcuts: [
        { label: "Media", keys: `${command}1`, scope: "Project" },
        { label: "Edit", keys: `${command}2`, scope: "Project" },
      ],
    },
    {
      title: "Media",
      shortcuts: [{ label: "Import media", keys: `${command}I`, scope: "Media" }],
    },
    {
      title: "Edit tools",
      shortcuts: [
        { label: "Selection tool", keys: "A", scope: "Edit" },
        { label: "Trim tool", keys: "T", scope: "Edit" },
        { label: "Blade tool", keys: "B", scope: "Edit" },
        { label: "Toggle snapping", keys: "S", scope: "Edit" },
        { label: "Split selected clip", keys: `${command}\\`, scope: "Edit" },
        { label: "Delete selected clip", keys: "⌫", scope: "Edit" },
      ],
    },
    {
      title: "Viewer transport",
      shortcuts: [
        { label: "Play or pause", keys: "Space", scope: "Edit" },
        { label: "Reverse / pause / forward", keys: "J  K  L", scope: "Edit" },
        { label: "Previous / next frame", keys: "←  →", scope: "Edit" },
        { label: "Go to beginning", keys: "Home", scope: "Edit" },
      ],
    },
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = groups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter((shortcut) =>
        [group.title, shortcut.label, shortcut.keys, shortcut.scope]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(normalizedQuery)),
      ),
    }))
    .filter((group) => group.shortcuts.length > 0);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="flex h-[520px] max-h-[calc(100vh-3rem)] max-w-3xl flex-col">
        <DialogHeader className="h-auto shrink-0 gap-5 border-b-0 px-5 pb-3 pt-5">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <SearchField
            aria-label="Search keyboard shortcuts"
            className="ml-auto w-64"
            placeholder="Search shortcuts…"
            size="sm"
            surface="muted"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 items-start gap-x-8 gap-y-6 px-5 pb-5 pt-2">
            {filteredGroups.length ? (
              filteredGroups.map((group) => (
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
              ))
            ) : (
              <p className="col-span-2 py-16 text-center text-ui text-muted">No shortcuts found</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
