import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_SETTING_DEFINITIONS } from "@cinesim/core";
import { describe, expect, it } from "vite-plus/test";
import { projectSettingPresentation } from "../src/renderer/components/settings/project-setting-presentation";

describe("project settings UI catalog", () => {
  it("projects every central setting definition into the desktop controls", async () => {
    const directory = join(import.meta.dirname, "../src/renderer/components/settings");
    const source = (
      await Promise.all(
        ["general-settings.tsx", "media-settings.tsx"].map((file) =>
          readFile(join(directory, file), "utf8"),
        ),
      )
    ).join("\n");

    for (const definition of PROJECT_SETTING_DEFINITIONS) {
      expect(source, definition.key).toContain(`projectSettingPresentation("${definition.key}")`);
      expect(projectSettingPresentation(definition.key)).toEqual({
        title: definition.title,
        detail: definition.description,
      });
    }
    expect(source).toContain("setNewProjectSettings");
    expect(source).toContain("Use current settings");
  });
});
