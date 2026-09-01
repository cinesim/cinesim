import { BUILTIN_REGISTRY } from "./registry";

export type CapabilityState = "supported" | "partial" | "unsupported";

export interface LanguageCapability {
  compiler: CapabilityState;
  preview: CapabilityState;
  export: CapabilityState;
  detail?: string;
}

export interface LanguageReferenceEntry {
  id: string;
  kind: "element" | "recipe";
  title: string;
  summary: string;
  syntax: string;
  example: string;
  tags: string[];
  properties?: Array<{
    name: string;
    type: string;
    required: boolean;
    animatable: boolean;
    options?: string[];
  }>;
  capability: LanguageCapability;
}

const previewSupported = new Set([
  "composition",
  "timeline",
  "track",
  "clip",
  "video",
  "audio",
  "image",
  "group",
  "grid",
  "stack",
  "rect",
  "ellipse",
  "colorgrade",
]);

const previewPartial = new Set(["marker", "text", "span", "captions"]);

function elementCapability(name: string): LanguageCapability {
  if (previewSupported.has(name))
    return { compiler: "supported", preview: "supported", export: "unsupported" };
  if (previewPartial.has(name))
    return {
      compiler: "supported",
      preview: "partial",
      export: "unsupported",
      detail:
        name === "text" || name === "span" || name === "captions"
          ? "Preview uses placeholder glyph rendering; production text shaping is not complete."
          : "The construct is visible in editorial UI but has no compositor pass.",
    };
  return {
    compiler: "supported",
    preview: "unsupported",
    export: "unsupported",
    detail: "Accepted by the compiler but not executed by the current compositor.",
  };
}

function elementSyntax(name: string, requiredProperties: readonly string[]): string {
  const properties = requiredProperties.map((property) => `${property}={...}`).join(" ");
  return properties ? `<${name} ${properties} />` : `<${name} />`;
}

function elementEntries(): LanguageReferenceEntry[] {
  return Object.values(BUILTIN_REGISTRY).map((schema) => {
    const properties = Object.values(schema.properties).map((property) => ({
      name: property.name,
      type: property.type,
      required: property.required,
      animatable: property.animatable,
      ...(property.options ? { options: property.options } : {}),
    }));
    const required = properties.filter((property) => property.required).map(({ name }) => name);
    const syntax = elementSyntax(schema.name, required);
    return {
      id: `element:${schema.name}`,
      kind: "element",
      title: `<${schema.name}>`,
      summary: `${schema.category} element with ${properties.length} typed properties.`,
      syntax,
      example: syntax,
      tags: [schema.name, schema.category, ...properties.map(({ name }) => name)],
      properties,
      capability: elementCapability(schema.name),
    };
  });
}

const recipes: LanguageReferenceEntry[] = [
  {
    id: "recipe:cutaway",
    kind: "recipe",
    title: "B-roll cutaway",
    summary:
      "Place a visual-only clip above continuing dialogue audio to preserve narrative continuity.",
    syntax: "linked A/V clips plus an overlay video clip",
    example:
      '<track id="track_broll" kind="video" name="B-roll"><clip id="clip_cutaway" asset={asset("asset_broll")} media="video" start={seconds(4)} in={seconds(2)} duration={seconds(3)} /></track>',
    tags: ["b-roll", "cutaway", "dialogue", "reaction", "continuity"],
    capability: { compiler: "supported", preview: "supported", export: "unsupported" },
  },
  {
    id: "recipe:montage",
    kind: "recipe",
    title: "Montage pacing",
    summary:
      "Use short adjacent clips with deliberate source selections and vary shot scale or action.",
    syntax: "adjacent <clip> elements on one video track",
    example:
      '<clip id="clip_beat_1" asset={asset("asset_a")} media="video" start={seconds(0)} in={seconds(3)} duration={seconds(1.5)} />',
    tags: ["montage", "pacing", "rhythm", "shots"],
    capability: { compiler: "supported", preview: "supported", export: "unsupported" },
  },
  {
    id: "recipe:dialogue-cleanup",
    kind: "recipe",
    title: "Dialogue cleanup",
    summary:
      "Trim pauses at word boundaries, retain room tone, and use short audio fades to avoid clicks.",
    syntax: "audio <clip> with in, duration, fadeIn, fadeOut, gain, and pan",
    example:
      '<clip id="clip_dialogue" asset={asset("asset_interview")} media="audio" start={seconds(0)} in={seconds(12)} duration={seconds(5)} fadeIn={milliseconds(12)} fadeOut={milliseconds(18)} gain={db(-1.5)} />',
    tags: ["dialogue", "audio", "cleanup", "fade", "room tone"],
    capability: { compiler: "supported", preview: "supported", export: "unsupported" },
  },
  {
    id: "recipe:split-edit",
    kind: "recipe",
    title: "Split edit / J-cut / L-cut",
    summary:
      "Linked audio and video clips may use independent boundaries; dedicated relationship semantics remain incomplete.",
    syntax: "linked media clips with different start and duration values",
    example: '<clip id="clip_audio" linked="clip_video" media="audio" start={seconds(1)} ... />',
    tags: ["split edit", "j-cut", "l-cut", "audio lead", "audio trail"],
    capability: {
      compiler: "partial",
      preview: "partial",
      export: "unsupported",
      detail:
        "Independent linked boundaries work, but first-class split-edit validation is not implemented.",
    },
  },
];

export const LANGUAGE_REFERENCE: readonly LanguageReferenceEntry[] = [
  ...elementEntries(),
  ...recipes,
];

function relevance(entry: LanguageReferenceEntry, query: string): number {
  if (!query) return entry.kind === "recipe" ? 2 : 1;
  const title = entry.title.toLowerCase();
  const searchable = [entry.id, entry.title, entry.summary, entry.syntax, ...entry.tags]
    .join(" ")
    .toLowerCase();
  if (title === query) return 100;
  if (title.includes(query)) return 60;
  const words = query.split(/\s+/u).filter(Boolean);
  const matches = words.filter((word) => searchable.includes(word)).length;
  return matches === words.length ? 20 + matches : matches;
}

export function searchLanguageReference(query: string, limit = 10): LanguageReferenceEntry[] {
  const normalized = query.trim().toLowerCase().slice(0, 200);
  return LANGUAGE_REFERENCE.map((entry) => ({ entry, score: relevance(entry, normalized) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map(({ entry }) => entry);
}
