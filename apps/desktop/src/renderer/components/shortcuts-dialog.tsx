import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, Kbd } from "@cinesim/ui";

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
  ];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogClose className="ml-auto" aria-label="Close keyboard shortcuts">
            <X size={15} />
          </DialogClose>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
