import { parse, stringify } from "smol-toml";
import type { ProjectSettings } from "../project/types";
import { parseSettings } from "./files";

interface SettingsTomlShape {
  version: number;
  autosave: boolean;
  preview: { quality: string; background_color: string };
  perception: { filmstrip_interval_seconds: number };
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
  });
}
