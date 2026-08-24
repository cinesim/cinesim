import { SlidersHorizontal } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
  SectionHeading,
} from "@cinesim/ui";
import { findClip } from "@cinesim/core";
import type { Project } from "@cinesim/core";
import { formatDuration } from "../lib/format";
import { useRendererStore } from "../store/renderer-store-context";

export function Inspector({ project }: { project: Project }) {
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
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
    <aside className="flex min-h-0 flex-col bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {location && asset ? (
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
          <Empty className="h-44">
            <EmptyHeader>
              <EmptyIcon className="mb-2">
                <SlidersHorizontal size={21} />
              </EmptyIcon>
              <EmptyTitle>Select a clip</EmptyTitle>
              <EmptyDescription>Its timing and transform will appear here</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </aside>
  );
}

function InspectorGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeading className="mb-2 border-b border-border pb-2">{title}</SectionHeading>
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
