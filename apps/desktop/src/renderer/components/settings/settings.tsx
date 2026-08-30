import type { ComponentType } from "react";
import type { SettingsSection } from "../../store/renderer-store";
import { AccountSettings } from "./account-settings";
import { AgentSettings } from "./agent-settings";
import { CloudStorageSettings } from "./cloud-storage-settings";
import { GeneralSettings } from "./general-settings";
import { MediaSettings } from "./media-settings";
import { TranscriptionSettings } from "./transcription-settings";

interface SettingsProps {
  section: SettingsSection;
}

const SETTINGS_SECTIONS = {
  account: AccountSettings,
  agents: AgentSettings,
  general: GeneralSettings,
  media: MediaSettings,
  storage: CloudStorageSettings,
  transcription: TranscriptionSettings,
} satisfies Record<SettingsSection, ComponentType>;

export function Settings({ section }: SettingsProps) {
  const Section = SETTINGS_SECTIONS[section];
  return (
    <section className="h-full overflow-y-auto bg-canvas px-8 py-9">
      <div className="mx-auto max-w-3xl">
        <Section />
      </div>
    </section>
  );
}
