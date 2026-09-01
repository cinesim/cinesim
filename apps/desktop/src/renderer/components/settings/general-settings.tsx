import { Notice, Select, Settings as SettingsIcon } from "@cinesim/ui";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { SettingRow, SettingsHeading } from "./settings-layout";

export function GeneralSettings() {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const update = useRendererStore((state) => state.updateProjectSettings);
  if (!session)
    return <Notice size="default">Open a project to configure its project settings.</Notice>;
  const settings = session.settings;
  return (
    <>
      <SettingsHeading
        icon={<SettingsIcon size={18} />}
        title="Project"
        detail="Canonical editing, compiler, and preview policies for this project"
      />
      <div className="divide-y divide-border rounded-xl border border-border bg-panel">
        <SettingRow title="Autosave" detail="Persist each validated editor command automatically.">
          <Select
            value={settings.autosave ? "on" : "off"}
            onChange={(event) => void update({ autosave: event.target.value === "on" })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
        <SettingRow
          title="Preview quality"
          detail="Limits interactive render resolution without changing timing or semantics."
        >
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
        <SettingRow
          title="Strict compiler"
          detail="Reject unsupported or ambiguous source instead of accepting experimental syntax."
        >
          <Select
            value={settings.compilerStrict ? "on" : "off"}
            onChange={(event) => void update({ compilerStrict: event.target.value === "on" })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
      </div>
    </>
  );
}
