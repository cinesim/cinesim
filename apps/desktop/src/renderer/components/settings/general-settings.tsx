import { Settings as SettingsIcon } from "@cinesim/ui";
import { SettingsHeading } from "./settings-layout";

export function GeneralSettings() {
  return (
    <>
      <SettingsHeading
        icon={<SettingsIcon size={18} />}
        title="General"
        detail="Global Cinesim preferences"
      />
      <div className="rounded-xl border border-border bg-panel p-6">
        <p className="text-ui font-medium">Project preferences stay with each project</p>
        <p className="mt-1 max-w-lg text-ui text-muted">
          Preview quality, autosave, and creative settings are stored in the open Cinesim project.
          Agent providers are configured separately in the Agents section.
        </p>
      </div>
    </>
  );
}
