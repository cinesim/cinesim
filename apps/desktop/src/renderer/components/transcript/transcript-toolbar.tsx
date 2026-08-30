import { User } from "@cinesim/ui";
import { Menu, MenuContent, MenuItem, MenuTrigger, SearchField } from "@cinesim/ui";
import type {
  TranscriptDocumentBlock,
  TranscriptDocumentSection,
} from "../../../shared/transcript";

const SPEAKER_COLORS = [
  "var(--metric-blue)",
  "var(--metric-violet)",
  "var(--metric-green)",
  "var(--metric-amber)",
] as const;

export interface TranscriptSpeakerOption {
  color: string;
  count: number;
  id: string;
  name: string;
}

interface TranscriptToolbarProps {
  onQueryChange: (query: string) => void;
  onSpeakerChange: (speakerId: string | null) => void;
  query: string;
  speakerFilter: string | null;
  speakers: readonly TranscriptSpeakerOption[];
}

export function transcriptSpeakerOptions(
  blocks: readonly TranscriptDocumentBlock[],
): TranscriptSpeakerOption[] {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.kind !== "utterance") continue;
    const id = block.utterance.speakerClusterId ?? "Unknown speaker";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, count], index) => ({
      id,
      count,
      name: id === "Unknown speaker" ? id : `Speaker ${index + 1}`,
      color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]!,
    }));
}

export function filterTranscriptSections(
  sections: readonly TranscriptDocumentSection[],
  query: string,
  speakerId: string | null,
): TranscriptDocumentSection[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return sections.filter((section) => {
    if (section.kind !== "paragraph") return !normalizedQuery && !speakerId;
    const words = section.paragraph.blocks.flatMap((block) =>
      block.kind === "utterance"
        ? block.utterance.tokens.flatMap((token) => (token.kind === "word" ? [token.word] : []))
        : [],
    );
    if (speakerId && !words.some((word) => word.speakerClusterId === speakerId)) return false;
    return (
      !normalizedQuery ||
      words.some((word) => word.text.toLocaleLowerCase().includes(normalizedQuery))
    );
  });
}

export function TranscriptToolbar({
  onQueryChange,
  onSpeakerChange,
  query,
  speakerFilter,
  speakers,
}: TranscriptToolbarProps) {
  return (
    <header className="shrink-0 border-b border-border bg-panel px-3 py-2">
      <div className="flex items-center gap-2">
        <SearchField
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search transcript…"
          aria-label="Search transcript"
          className="min-w-0 flex-1"
        />
        <Menu>
          <MenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-ui-xs text-secondary hover:bg-surface">
            <User size={13} /> Speakers
            {speakerFilter && <span className="size-1.5 rounded-full bg-accent" />}
          </MenuTrigger>
          <MenuContent align="end" className="w-52">
            <MenuItem onClick={() => onSpeakerChange(null)}>All speakers</MenuItem>
            {speakers.map((speaker) => (
              <MenuItem key={speaker.id} onClick={() => onSpeakerChange(speaker.id)}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: speaker.color }}
                />
                <span className="flex-1">{speaker.name}</span>
                <span className="text-muted tabular-nums">{speaker.count}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}
