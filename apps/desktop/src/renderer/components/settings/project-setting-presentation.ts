import { projectSettingDefinition } from "@cinesim/core";
import type { ProjectSettings } from "@cinesim/core";

export function projectSettingPresentation(key: keyof ProjectSettings) {
  const definition = projectSettingDefinition(key);
  return { title: definition.title, detail: definition.description };
}
