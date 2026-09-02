import { Film, Input, Notice, Select } from "@cinesim/ui";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { SettingRow, SettingsHeading } from "./settings-layout";
import { projectSettingPresentation } from "./project-setting-presentation";

const PROXY_PRESETS = {
  "space-saver": { proxyMaxLongEdge: 960, proxyFrameRateCap: 30, proxyQuality: "low" },
  balanced: { proxyMaxLongEdge: 1280, proxyFrameRateCap: 60, proxyQuality: "medium" },
  "high-quality": { proxyMaxLongEdge: 1920, proxyFrameRateCap: 60, proxyQuality: "high" },
} as const;

export function MediaSettings() {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const update = useRendererStore((state) => state.updateProjectSettings);
  if (!session)
    return (
      <Notice size="default">Open a project to configure its media and proxy settings.</Notice>
    );
  const settings = session.settings;

  async function updateProfile(profile: typeof settings.proxyProfile): Promise<void> {
    await update({
      proxyProfile: profile,
      ...(profile === "custom" ? {} : PROXY_PRESETS[profile]),
    });
  }

  return (
    <>
      <SettingsHeading
        icon={<Film size={18} />}
        title="Media & proxies"
        detail="Choose how local edit representations are created for this project"
      />
      <Notice className="mb-5 rounded-lg bg-panel" size="default">
        Balanced is a good starting point. Cloud originals always keep a local proxy for responsive
        editing, and the original is moved to Trash only after both upload and proxy finish.
      </Notice>
      <div className="divide-y divide-border rounded-xl border border-border bg-panel">
        <SettingRow {...projectSettingPresentation("defaultFilmstripIntervalSeconds")}>
          <Input
            type="number"
            min={0.1}
            step={0.1}
            value={settings.defaultFilmstripIntervalSeconds}
            onChange={(event) =>
              void update({ defaultFilmstripIntervalSeconds: Number(event.target.value) })
            }
          />
        </SettingRow>
        <SettingRow {...projectSettingPresentation("proxyGeneration")}>
          <Select
            value={settings.proxyGeneration}
            onChange={(event) =>
              void update({ proxyGeneration: event.target.value as "automatic" | "manual" })
            }
          >
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </Select>
        </SettingRow>
        <SettingRow {...projectSettingPresentation("proxyProfile")}>
          <Select
            value={settings.proxyProfile}
            onChange={(event) =>
              void updateProfile(event.target.value as typeof settings.proxyProfile)
            }
          >
            <option value="space-saver">Space saver · 960 px / 30 fps</option>
            <option value="balanced">Balanced · 1280 px / up to 60 fps</option>
            <option value="high-quality">High quality · 1920 px / up to 60 fps</option>
            <option value="custom">Custom</option>
          </Select>
        </SettingRow>
        {settings.proxyProfile === "custom" && (
          <>
            <SettingRow {...projectSettingPresentation("proxyMaxLongEdge")}>
              <Input
                type="number"
                min={320}
                max={7680}
                value={settings.proxyMaxLongEdge}
                onChange={(event) => void update({ proxyMaxLongEdge: Number(event.target.value) })}
              />
            </SettingRow>
            <SettingRow {...projectSettingPresentation("proxyFrameRateCap")}>
              <Select
                value={settings.proxyFrameRateCap}
                onChange={(event) =>
                  void update({ proxyFrameRateCap: Number(event.target.value) as 30 | 60 })
                }
              >
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </Select>
            </SettingRow>
            <SettingRow {...projectSettingPresentation("proxyQuality")}>
              <Select
                value={settings.proxyQuality}
                onChange={(event) =>
                  void update({
                    proxyQuality: event.target.value as "low" | "medium" | "high",
                  })
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </SettingRow>
          </>
        )}
        <SettingRow {...projectSettingPresentation("workingColorSpace")}>
          <Select value={settings.workingColorSpace} disabled>
            <option value="linear-rec709">Linear Rec.709</option>
          </Select>
        </SettingRow>
        <SettingRow {...projectSettingPresentation("outputColorSpace")}>
          <Select value={settings.outputColorSpace} disabled>
            <option value="rec709-sdr">Rec.709 SDR</option>
          </Select>
        </SettingRow>
        <SettingRow {...projectSettingPresentation("toneMapping")}>
          <Select
            value={settings.toneMapping}
            onChange={(event) =>
              void update({ toneMapping: event.target.value as typeof settings.toneMapping })
            }
          >
            <option value="automatic">Automatic</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
        <SettingRow {...projectSettingPresentation("uncertainColorHandling")}>
          <Select
            value={settings.uncertainColorHandling}
            onChange={(event) =>
              void update({
                uncertainColorHandling: event.target
                  .value as typeof settings.uncertainColorHandling,
              })
            }
          >
            <option value="warn">Warn</option>
            <option value="assume-rec709">Assume Rec.709</option>
          </Select>
        </SettingRow>
      </div>
    </>
  );
}
