import { NotesEditor } from "./notes-editor";

export function NotesPanel() {
  return (
    <aside className="min-h-0 overflow-y-auto bg-panel p-3">
      <p className="mb-2 text-ui-xs leading-4 text-muted">
        Working notes surface powered by Lexical. Canonical creative direction belongs in the
        project's AGENTS.md.
      </p>
      <NotesEditor />
    </aside>
  );
}
