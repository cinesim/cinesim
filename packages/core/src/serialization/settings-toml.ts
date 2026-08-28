import { parse, stringify } from "smol-toml";
import type { ProjectSettings } from "../project/types";
import { parseSettings } from "./files";

interface SettingsTomlShape {
  version: number;
  autosave: boolean;
  preview: { quality: string; background_color: string };
  perception: { filmstrip_interval_seconds: number };
  proxy?: {
    generation?: string;
    profile?: string;
    max_long_edge?: number;
    frame_rate_cap?: number;
    quality?: string;
  };
}

export function settingsToToml(settings: ProjectSettings): string {
  return `${stringify({
    version: settings.version,
    autosave: settings.autosave,
    preview: {
      quality: settings.previewQuality,
      background_color: settings.backgroundColor,
    },
    perception: {
      filmstrip_interval_seconds: settings.defaultFilmstripIntervalSeconds,
    },
    proxy: {
      generation: settings.proxyGeneration,
      profile: settings.proxyProfile,
      max_long_edge: settings.proxyMaxLongEdge,
      frame_rate_cap: settings.proxyFrameRateCap,
      quality: settings.proxyQuality,
    },
  })}\n`;
}

export function settingsFromToml(source: string): ProjectSettings {
  const value = parse(source) as unknown as SettingsTomlShape;
  return parseSettings({
    version: value.version,
    autosave: value.autosave,
    previewQuality: value.preview?.quality,
    backgroundColor: value.preview?.background_color,
    defaultFilmstripIntervalSeconds: value.perception?.filmstrip_interval_seconds,
    proxyGeneration: value.proxy?.generation ?? "automatic",
    proxyProfile: value.proxy?.profile ?? "balanced",
    proxyMaxLongEdge: value.proxy?.max_long_edge ?? 1280,
    proxyFrameRateCap: value.proxy?.frame_rate_cap ?? 60,
    proxyQuality: value.proxy?.quality ?? "medium",
  });
}
