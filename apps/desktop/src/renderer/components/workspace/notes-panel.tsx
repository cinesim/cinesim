import { useState } from "react";
import { EDITORIAL_NOTE_KINDS, timeUs } from "@cinesim/core";
import type { EditorialNote, Project, Sequence, TimelineNote } from "@cinesim/core";
import { Button } from "@cinesim/ui";
import { useRendererStore } from "../../store/renderer-store-context";

type NoteView = EditorialNote | TimelineNote;
type NoteTarget =
  | { kind: "project"; label: string }
  | { kind: "asset"; label: string; assetId: `asset_${string}` }
  | { kind: "timeline"; label: string; sequenceId: `sequence_${string}` };

interface NoteSection {
  target: NoteTarget;
  notes: NoteView[];
}

interface NoteDraft {
  target: NoteTarget;
  note?: NoteView;
}

function noteSections(
  project: Project,
  activeSequence: Sequence | undefined,
  selectedAssetIds: readonly string[],
): NoteSection[] {
  const sections: NoteSection[] = [
    { target: { kind: "project", label: "Project" }, notes: project.notes },
  ];
  if (activeSequence)
    sections.push({
      target: { kind: "timeline", label: activeSequence.name, sequenceId: activeSequence.id },
      notes: activeSequence.notes,
    });
  for (const asset of project.assets
    .filter(({ id }) => selectedAssetIds.includes(id))
    .slice(0, 5)) {
    sections.push({
      target: { kind: "asset", label: asset.name, assetId: asset.id },
      notes: asset.notes ?? [],
    });
  }
  return sections;
}

function targetCommandFields(target: NoteTarget) {
  if (target.kind === "asset") return { target: target.kind, assetId: target.assetId } as const;
  if (target.kind === "timeline")
    return { target: target.kind, sequenceId: target.sequenceId } as const;
  return { target: target.kind } as const;
}

function formatNoteTime(note: NoteView): string | null {
  if (!("atUs" in note)) return null;
  const duration =
    note.durationUs === undefined ? "" : ` · ${(note.durationUs / 1_000_000).toFixed(1)}s`;
  return `${(note.atUs / 1_000_000).toFixed(1)}s${duration}`;
}

function NoteSectionView(props: {
  section: NoteSection;
  onAdd: (target: NoteTarget) => void;
  onEdit: (target: NoteTarget, note: NoteView) => void;
  onRemove: (target: NoteTarget, noteId: string) => void;
}) {
  const { section } = props;
  return (
    <section className="space-y-2 border-b border-border pb-3 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-ui-xs font-semibold uppercase tracking-wide text-muted">
            {section.target.kind}
          </p>
          <p className="truncate text-ui-sm text-primary">{section.target.label}</p>
        </div>
        <Button variant="ghost" onClick={() => props.onAdd(section.target)}>
          Add
        </Button>
      </div>
      {section.notes.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-2 text-ui-xs text-muted">
          No structured notes.
        </p>
      ) : (
        section.notes.map((note) => (
          <article key={note.id} className="rounded-md border border-border bg-panel-muted p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-ui-xs font-medium text-secondary">{note.kind}</p>
                {formatNoteTime(note) && (
                  <p className="text-ui-xs tabular-nums text-muted">{formatNoteTime(note)}</p>
                )}
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="text-ui-xs text-muted hover:text-primary"
                  onClick={() => props.onEdit(section.target, note)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-ui-xs text-muted hover:text-danger"
                  onClick={() => props.onRemove(section.target, note.id)}
                >
                  Delete
                </button>
              </div>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-ui-sm leading-5 text-primary">
              {note.text}
            </p>
          </article>
        ))
      )}
    </section>
  );
}

function NoteForm(props: {
  draft: NoteDraft;
  playheadUs: number;
  onCancel: () => void;
  onSave: (value: {
    kind: EditorialNote["kind"];
    text: string;
    atSeconds: number;
    durationSeconds: number;
  }) => void;
}) {
  const [kind, setKind] = useState<EditorialNote["kind"]>(props.draft.note?.kind ?? "general");
  const [text, setText] = useState(props.draft.note?.text ?? "");
  const timelineNote = props.draft.note && "atUs" in props.draft.note ? props.draft.note : null;
  const [atSeconds, setAtSeconds] = useState((timelineNote?.atUs ?? props.playheadUs) / 1_000_000);
  const [durationSeconds, setDurationSeconds] = useState(
    (timelineNote?.durationUs ?? 0) / 1_000_000,
  );
  return (
    <form
      className="space-y-2 rounded-md border border-accent/50 bg-panel-muted p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) props.onSave({ kind, text: text.trim(), atSeconds, durationSeconds });
      }}
    >
      <p className="text-ui-xs font-medium text-secondary">
        {props.draft.note ? "Edit" : "Add"} {props.draft.target.label} note
      </p>
      <select
        className="h-8 w-full rounded border border-border bg-panel px-2 text-ui-sm"
        value={kind}
        onChange={(event) => setKind(event.target.value as EditorialNote["kind"])}
      >
        {EDITORIAL_NOTE_KINDS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      {props.draft.target.kind === "timeline" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-ui-xs text-muted">
            Start (seconds)
            <input
              className="mt-1 h-8 w-full rounded border border-border bg-panel px-2 text-primary"
              type="number"
              min={0}
              step={0.001}
              value={atSeconds}
              onChange={(event) => setAtSeconds(Math.max(0, Number(event.target.value)))}
            />
          </label>
          <label className="text-ui-xs text-muted">
            Duration
            <input
              className="mt-1 h-8 w-full rounded border border-border bg-panel px-2 text-primary"
              type="number"
              min={0}
              step={0.001}
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(Math.max(0, Number(event.target.value)))}
            />
          </label>
        </div>
      )}
      <textarea
        aria-label="Note text"
        className="min-h-28 w-full resize-y rounded border border-border bg-panel p-2 text-ui-sm leading-5 text-primary outline-none focus:border-accent"
        maxLength={20_000}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!text.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function NotesPanel() {
  const session = useRendererStore((state) =>
    state.project.status === "ready" ? state.project.session : null,
  );
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const selectedAssetIds = useRendererStore((state) => state.selectedAssetIds);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const execute = useRendererStore((state) => state.execute);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  if (!session) return null;
  const activeSequence = session.project.sequences.find(({ id }) => id === activeSequenceId);
  const sections = noteSections(session.project, activeSequence, selectedAssetIds);

  async function saveNote(value: {
    kind: EditorialNote["kind"];
    text: string;
    atSeconds: number;
    durationSeconds: number;
  }) {
    if (!draft) return;
    const note = {
      id: draft.note?.id ?? `note_${crypto.randomUUID().replaceAll("-", "")}`,
      kind: value.kind,
      text: value.text,
      ...(draft.target.kind === "timeline"
        ? {
            atUs: timeUs(Math.round(value.atSeconds * 1_000_000)),
            ...(value.durationSeconds > 0
              ? { durationUs: timeUs(Math.round(value.durationSeconds * 1_000_000)) }
              : {}),
          }
        : {}),
    };
    const result = await execute({
      type: "note.upsert",
      ...targetCommandFields(draft.target),
      note,
    });
    if (result.ok) setDraft(null);
  }

  async function removeNote(target: NoteTarget, noteId: string) {
    await execute({ type: "note.remove", ...targetCommandFields(target), noteId });
  }

  return (
    <aside className="min-h-0 space-y-3 overflow-y-auto bg-panel p-3">
      <p className="text-ui-xs leading-4 text-muted">
        Canonical structured notes are stored in project TOML, asset TOML, or timeline JSX.
      </p>
      {draft && (
        <NoteForm
          key={`${draft.target.kind}:${draft.note?.id ?? "new"}`}
          draft={draft}
          playheadUs={playheadUs}
          onCancel={() => setDraft(null)}
          onSave={(value) => void saveNote(value)}
        />
      )}
      {sections.map((section) => (
        <NoteSectionView
          key={`${section.target.kind}:${section.target.label}`}
          section={section}
          onAdd={(target) => setDraft({ target })}
          onEdit={(target, note) => setDraft({ target, note })}
          onRemove={(target, noteId) => void removeNote(target, noteId)}
        />
      ))}
    </aside>
  );
}
