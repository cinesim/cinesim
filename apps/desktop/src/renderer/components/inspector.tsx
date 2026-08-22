import { useState } from "react";
import { SlidersHorizontal, StickyNote } from "lucide-react";
import { Button } from "@cinesim/ui";
import { findClip } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import { formatDuration } from "../lib/format";
import { NotesEditor } from "./notes-editor";
import { useUiStore } from "../store/ui-store";

export function Inspector({ project }: { project: Project }) {
  const selectedClipId = useUiStore((state) => state.selectedClipId);
  const [tab, setTab] = useState<"properties" | "notes">("properties");
  const location = selectedClipId
    ? (() => {
        try {
          return findClip(project, selectedClipId);
        } catch {
          return null;
        }
      })()
    : null;
  const asset = location
    ? project.assets.find((candidate) => candidate.id === location.clip.assetId)
    : null;

  return (
    <aside className="flex min-h-0 flex-col border-l border-border bg-panel">
      <div className="flex h-10 items-center border-b border-border px-2">
        <Button
          className="flex-1"
          size="sm"
          variant={tab === "properties" ? "secondary" : "ghost"}
          onClick={() => setTab("properties")}
        >
          <SlidersHorizontal size={12} /> Inspector
        </Button>
        <Button
          className="flex-1"
          size="sm"
          variant={tab === "notes" ? "secondary" : "ghost"}
          onClick={() => setTab("notes")}
        >
          <StickyNote size={12} /> Notes
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "notes" ? (
          <>
            <p className="mb-2 text-ui-xs leading-4 text-muted">
              Working notes surface powered by Lexical. Canonical creative direction belongs in the
              project's AGENTS.md.
            </p>
            <NotesEditor />
          </>
        ) : location && asset ? (
          <div className="space-y-5">
            <div>
              <p className="truncate text-ui font-medium text-primary">{asset.name}</p>
              <p className="mt-1 text-ui-xs text-muted tabular-nums">{location.clip.id}</p>
            </div>
            <InspectorGroup title="Timing">
              <ReadonlyField
                label="Timeline start"
                value={formatDuration(location.clip.timelineStartUs)}
              />
              <ReadonlyField
                label="Duration"
                value={formatDuration(location.clip.sourceEndUs - location.clip.sourceStartUs)}
              />
              <ReadonlyField
                label="Source in"
                value={formatDuration(location.clip.sourceStartUs)}
              />
              <ReadonlyField label="Source out" value={formatDuration(location.clip.sourceEndUs)} />
            </InspectorGroup>
            <InspectorGroup title="Transform">
              <ReadonlyField
                label="Position"
                value={`${location.clip.transform.x.toFixed(2)}, ${location.clip.transform.y.toFixed(2)}`}
              />
              <ReadonlyField
                label="Scale"
                value={`${location.clip.transform.scaleX.toFixed(2)} × ${location.clip.transform.scaleY.toFixed(2)}`}
              />
              <ReadonlyField
                label="Opacity"
                value={`${Math.round(location.clip.transform.opacity * 100)}%`}
              />
              <ReadonlyField label="Fit" value={location.clip.transform.fit} />
            </InspectorGroup>
            <InspectorGroup title="Source">
              <ReadonlyField
                label="Resolution"
                value={asset.width && asset.height ? `${asset.width} × ${asset.height}` : "—"}
              />
              <ReadonlyField
                label="Frame rate"
                value={asset.frameRate ? asset.frameRate.toFixed(2) : "—"}
              />
              <ReadonlyField label="Audio" value={asset.hasAudio ? "Present" : "None"} />
            </InspectorGroup>
          </div>
        ) : (
          <div className="grid h-44 place-items-center text-center">
            <span>
              <SlidersHorizontal className="mx-auto mb-2 text-disabled" size={21} />
              <span className="block text-ui text-muted">Select a clip</span>
              <span className="mt-1 block text-ui-xs text-muted">
                Its timing and transform will appear here
              </span>
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

function InspectorGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 border-b border-border pb-2 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center text-ui-xs">
      <span className="text-muted">{label}</span>
      <span className="truncate rounded border border-border bg-panel-muted px-2 py-1.5 text-secondary">
        {value}
      </span>
    </div>
  );
}
