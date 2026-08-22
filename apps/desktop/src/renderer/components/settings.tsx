import { Settings as SettingsIcon } from "lucide-react";

export function Settings() {
  return (
    <section className="h-full overflow-y-auto bg-canvas px-8 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border border-border bg-panel">
            <SettingsIcon size={18} className="text-secondary" />
          </span>
          <div>
            <h1 className="text-ui-lg font-semibold tracking-tight">Settings</h1>
            <p className="text-ui text-muted">Global Cinesim preferences</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-panel p-6">
          <p className="text-ui font-medium">Nothing to configure yet</p>
          <p className="mt-1 max-w-lg text-ui text-muted">
            Application-wide settings will live here. Project-specific settings will remain with
            each project when that UI is introduced.
          </p>
        </div>
      </div>
    </section>
  );
}
