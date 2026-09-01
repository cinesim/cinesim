import { z } from "zod";
import type { ProjectSettings } from "./types";

type ProjectSettingDefinition<K extends keyof ProjectSettings = keyof ProjectSettings> = {
  key: K;
  table: "settings" | "compiler";
  tomlKey: string;
  title: string;
  description: string;
  defaultValue: ProjectSettings[K];
  schema: z.ZodType<ProjectSettings[K]>;
};

export const PROJECT_SETTING_DEFINITIONS = [
  {
    key: "autosave",
    table: "settings",
    tomlKey: "autosave",
    title: "Autosave",
    description: "Persist validated editor commands automatically.",
    defaultValue: true,
    schema: z.boolean(),
  },
  {
    key: "previewQuality",
    table: "settings",
    tomlKey: "preview_quality",
    title: "Preview quality",
    description: "Maximum interactive compositor resolution.",
    defaultValue: "half",
    schema: z.enum(["full", "half", "quarter"]),
  },
  {
    key: "backgroundColor",
    table: "settings",
    tomlKey: "background_color",
    title: "Canvas background",
    description: "Project viewer background color.",
    defaultValue: "#09090b",
    schema: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  },
  {
    key: "defaultFilmstripIntervalSeconds",
    table: "settings",
    tomlKey: "filmstrip_interval_seconds",
    title: "Filmstrip interval",
    description: "Default spacing between disposable perception samples.",
    defaultValue: 5,
    schema: z.number().positive(),
  },
  {
    key: "proxyGeneration",
    table: "settings",
    tomlKey: "proxy_generation",
    title: "Proxy generation",
    description: "Whether local edit proxies are queued automatically.",
    defaultValue: "automatic",
    schema: z.enum(["automatic", "manual"]),
  },
  {
    key: "proxyProfile",
    table: "settings",
    tomlKey: "proxy_profile",
    title: "Proxy profile",
    description: "Named proxy resolution, frame-rate, and quality policy.",
    defaultValue: "balanced",
    schema: z.enum(["space-saver", "balanced", "high-quality", "custom"]),
  },
  {
    key: "proxyMaxLongEdge",
    table: "settings",
    tomlKey: "proxy_max_long_edge",
    title: "Proxy maximum long edge",
    description: "Maximum proxy width or height in pixels.",
    defaultValue: 1280,
    schema: z.number().int().min(320).max(7680),
  },
  {
    key: "proxyFrameRateCap",
    table: "settings",
    tomlKey: "proxy_frame_rate_cap",
    title: "Proxy frame-rate cap",
    description: "Maximum proxy frame rate while preserving lower source rates.",
    defaultValue: 60,
    schema: z.union([z.literal(30), z.literal(60)]),
  },
  {
    key: "proxyQuality",
    table: "settings",
    tomlKey: "proxy_quality",
    title: "Proxy quality",
    description: "Proxy encoding quality tier.",
    defaultValue: "medium",
    schema: z.enum(["low", "medium", "high"]),
  },
  {
    key: "compilerStrict",
    table: "compiler",
    tomlKey: "strict",
    title: "Strict compiler",
    description: "Reject unsupported or ambiguous source constructs.",
    defaultValue: true,
    schema: z.boolean(),
  },
  {
    key: "workingColorSpace",
    table: "settings",
    tomlKey: "working_color_space",
    title: "Working color space",
    description: "Linear space used by the compositor for grades and effects.",
    defaultValue: "linear-rec709",
    schema: z.literal("linear-rec709"),
  },
  {
    key: "outputColorSpace",
    table: "settings",
    tomlKey: "output_color_space",
    title: "Output color space",
    description: "Display and export color encoding policy.",
    defaultValue: "rec709-sdr",
    schema: z.literal("rec709-sdr"),
  },
  {
    key: "toneMapping",
    table: "settings",
    tomlKey: "tone_mapping",
    title: "HDR tone mapping",
    description: "Explicit reversible handling for HDR sources in the SDR pipeline.",
    defaultValue: "automatic",
    schema: z.enum(["automatic", "off"]),
  },
  {
    key: "uncertainColorHandling",
    table: "settings",
    tomlKey: "uncertain_color_handling",
    title: "Uncertain color metadata",
    description: "Warn or explicitly assume Rec.709 when source interpretation is incomplete.",
    defaultValue: "warn",
    schema: z.enum(["warn", "assume-rec709"]),
  },
] as const satisfies readonly ProjectSettingDefinition[];

export const DEFAULT_SETTINGS = Object.fromEntries(
  PROJECT_SETTING_DEFINITIONS.map((definition) => [definition.key, definition.defaultValue]),
) as unknown as ProjectSettings;

type ProjectSettingsShape = {
  [K in keyof ProjectSettings]: z.ZodType<ProjectSettings[K]>;
};

export const projectSettingsSchema = z.object(
  Object.fromEntries(
    PROJECT_SETTING_DEFINITIONS.map((definition) => [definition.key, definition.schema]),
  ) as unknown as ProjectSettingsShape,
);

export function projectSettingDefinition<K extends keyof ProjectSettings>(
  key: K,
): ProjectSettingDefinition<K> {
  const definition = PROJECT_SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Unknown project setting: ${key}`);
  return definition as unknown as ProjectSettingDefinition<K>;
}
