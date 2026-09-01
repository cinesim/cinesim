import { editorialNoteSchema } from "@cinesim/core";
import type { EditorialNote } from "@cinesim/core";
import { stringify } from "smol-toml";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be a TOML table.`);
  return value as Record<string, unknown>;
}

export function parseEditorialNotes(value: unknown, name: string): EditorialNote[] {
  if (value === undefined) return [];
  return Object.entries(record(value, name))
    .map(([id, note]) => editorialNoteSchema.parse({ id, ...record(note, `${name}.${id}`) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function editorialNotesShape(notes: readonly EditorialNote[]): Record<string, unknown> {
  return Object.fromEntries(
    [...notes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, kind, text }) => [id, { kind, text }]),
  );
}

function tableRange(source: string, header: string): { start: number; end: number } | undefined {
  const escaped = header.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\[${escaped}\\][ \\t]*(?:\\r?\\n|$)`, "mu").exec(source);
  if (!match || match.index === undefined) return undefined;
  const next = /^\[[^\r\n]+\][ \t]*(?:\r?\n|$)/gmu;
  next.lastIndex = match.index + match[0].length;
  return { start: match.index, end: next.exec(source)?.index ?? source.length };
}

function noteBlock(header: string, note: EditorialNote): string {
  const body = stringify({ kind: note.kind, text: note.text.trim() });
  return `[${header}]\n${body.trim()}\n`;
}

export function patchEditorialNoteSource(
  source: string,
  tablePrefix: string,
  noteId: string,
  note: EditorialNote | null,
): string {
  const header = `${tablePrefix}.${noteId}`;
  const range = tableRange(source, header);
  if (!note) {
    if (!range) throw new Error(`Note not found: ${noteId}`);
    return `${source.slice(0, range.start)}${source.slice(range.end)}`;
  }
  const block = noteBlock(header, note);
  if (range) return `${source.slice(0, range.start)}${block}${source.slice(range.end)}`;
  const separator = source.endsWith("\n") ? "\n" : "\n\n";
  return `${source}${separator}${block}`;
}
