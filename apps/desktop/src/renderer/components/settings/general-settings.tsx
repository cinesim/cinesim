import { DEFAULT_SETTINGS } from "@cinesim/core";
import { Button, Input, Notice, Select, Settings as SettingsIcon } from "@cinesim/ui";
import { useState } from "react";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { SettingRow, SettingsHeading } from "./settings-layout";
import { projectSettingPresentation } from "./project-setting-presentation";

export function GeneralSettings() {
  const [defaultsStatus, setDefaultsStatus] = useState<string | null>(null);
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const update = useRendererStore((state) => state.updateProjectSettings);
  if (!session)
    return <Notice size="default">Open a project to configure its project settings.</Notice>;
  const settings = session.settings;
  const saveNewProjectSettings = async (next: typeof settings, message: string) => {
    try {
      await window.cinesim.appState.setNewProjectSettings(next);
      setDefaultsStatus(message);
    } catch (error) {
      setDefaultsStatus(error instanceof Error ? error.message : "Defaults could not be saved.");
    }
  };
  return (
    <>
      <SettingsHeading
        icon={<SettingsIcon size={18} />}
        title="Project"
        detail="Canonical editing, compiler, and preview policies for this project"
      />
      <div className="divide-y divide-border rounded-xl border border-border bg-panel">
        <SettingRow {...projectSettingPresentation("autosave")}>
          <Select
            value={settings.autosave ? "on" : "off"}
            onChange={(event) => void update({ autosave: event.target.value === "on" })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
        <SettingRow {...projectSettingPresentation("previewQuality")}>
          <Select
            value={settings.previewQuality}
            onChange={(event) =>
              void update({
                previewQuality: event.target.value as typeof settings.previewQuality,
              })
            }
          >
            <option value="full">Full</option>
            <option value="half">Half</option>
            <option value="quarter">Quarter</option>
          </Select>
        </SettingRow>
        <SettingRow {...projectSettingPresentation("backgroundColor")}>
          <Input
            type="color"
            value={settings.backgroundColor}
            aria-label="Project canvas background color"
            onChange={(event) => void update({ backgroundColor: event.target.value })}
          />
        </SettingRow>
        <SettingRow {...projectSettingPresentation("compilerStrict")}>
          <Select
            value={settings.compilerStrict ? "on" : "off"}
            onChange={(event) => void update({ compilerStrict: event.target.value === "on" })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
      </div>
      <div className="mt-4 divide-y divide-border rounded-xl border border-border bg-panel">
        <SettingRow
          title="New-project defaults"
          detail="Application defaults copied into cinesim.toml whenever a project is created."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() =>
                void saveNewProjectSettings(settings, "Current project settings saved as defaults.")
              }
            >
              Use current settings
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void saveNewProjectSettings(DEFAULT_SETTINGS, "New-project defaults reset.")
              }
            >
              Reset defaults
            </Button>
          </div>
          {defaultsStatus ? <p className="mt-2 text-ui-xs text-muted">{defaultsStatus}</p> : null}
        </SettingRow>
      </div>
    </>
  );
}
