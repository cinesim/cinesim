import { useState } from "react";
import { AudioLines, Notice, Select } from "@cinesim/ui";
import type { TranscriptionSettings as TranscriptionSettingsState } from "../../../shared/contracts";
import { useRendererStore } from "../../store/renderer-store-context";
import { SettingRow, SettingsHeading } from "./settings-layout";

export function TranscriptionSettings() {
  const account = useRendererStore((state) => state.account);
  const settings = useRendererStore((state) => state.appState.transcriptionSettings);
  const save = useRendererStore((state) => state.saveTranscriptionSettings);
  const [saving, setSaving] = useState(false);

  async function update(next: TranscriptionSettingsState): Promise<void> {
    if (account.status !== "signed-in" || !account.user) return;
    setSaving(true);
    await save(next);
    setSaving(false);
  }

  return (
    <>
      <SettingsHeading
        icon={<AudioLines size={18} />}
        title="Transcription"
        detail="Choose how speech transcripts are generated for your account"
      />
      {account.status !== "signed-in" ? (
        <Notice size="default">Sign in to configure remote transcription.</Notice>
      ) : account.transcription !== true ? (
        <Notice size="default">
          Transcription is not configured for this Cinesim service. Your preference will remain
          available when the service enables it.
        </Notice>
      ) : (
        <>
          <Notice className="mb-5 rounded-lg bg-panel" size="default">
            Transcription sends bounded audio chunks directly to Deepgram. Audio leaves this Mac;
            the generated transcript remains disposable data under
            <code className="mx-1 rounded bg-panel-muted px-1 py-0.5 text-primary">.video</code>.
            Automatic generation queues newly encountered speech media while you are signed in.
          </Notice>
          <div className="divide-y divide-border rounded-xl border border-border bg-panel">
            <SettingRow
              title="Transcription generation"
              detail="Choose whether audio-bearing media is queued when an open project is inspected."
            >
              <Select
                className="w-full"
                value={settings.generation}
                disabled={saving}
                onChange={(event) =>
                  void update({
                    ...settings,
                    generation: event.target.value as TranscriptionSettingsState["generation"],
                  })
                }
              >
                <option value="manual">Manual</option>
                <option value="automatic">Automatic</option>
              </Select>
            </SettingRow>
            <SettingRow
              title="Speech model"
              detail="The timing, diarization, and formatting model used for generated transcripts."
            >
              <Select
                className="w-full"
                value={settings.model}
                disabled={saving}
                onChange={(event) =>
                  void update({
                    ...settings,
                    model: event.target.value as TranscriptionSettingsState["model"],
                  })
                }
              >
                <option value="deepgram/nova-3">Deepgram Nova-3 · Direct</option>
              </Select>
            </SettingRow>
          </div>
          <div className="mt-5 rounded-xl border border-border bg-panel p-5">
            <p className="text-ui font-medium text-primary">Document-editing features</p>
            <p className="mt-1 text-ui leading-5 text-muted">
              Nova-3 runs with word timings, confidence, speaker diarization, utterances,
              paragraphs, punctuation, smart formatting, language detection, keyterms, and filler
              words. Profanity filtering and automatic redaction remain off so the transcript does
              not silently change the source record.
            </p>
          </div>
        </>
      )}
    </>
  );
}
