import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
  SearchField,
  SlidersHorizontal,
} from "@cinesim/ui";
import { timeUs } from "@cinesim/core";
import { useState } from "react";
import type { DesktopProjectSession } from "../../../shared/contracts";
import { formatDuration } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";
import {
  InspectorGroup,
  ReadonlyField,
  SceneControls,
  SemanticControls,
} from "./inspector-controls";
import {
  CLIP_INSPECTOR_PROPERTIES,
  inspectorSelectionMatches,
  matchesInspectorQuery,
  selectedSemanticClip,
} from "./inspector-model";

export function Inspector({ session }: { session: DesktopProjectSession }) {
  const execute = useRendererStore((state) => state.execute);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const [query, setQuery] = useState("");
  const selection = selectedSemanticClip(session, selectedClipId);
  const asset = selection?.clip.assetId
    ? session.project.assets.find((candidate) => candidate.id === selection.clip.assetId)
    : null;
  const hasMatches = selection
    ? inspectorSelectionMatches(session, selection, asset !== null, query)
    : false;

  return (
    <aside className="flex min-h-0 flex-col bg-panel">
      {selection && (
        <div className="px-2 pt-2">
          <SearchField
            aria-label="Search inspector properties"
            className="border-0 bg-transparent shadow-none"
            inputClassName="text-ui-xs"
            placeholder="Search properties"
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {selection ? (
          <div>
            <div className="border-b border-border/70 px-1 py-2.5">
              <p className="truncate text-ui-xs font-semibold text-primary">
                {asset?.name ?? selection.clip.name ?? "Generated clip"}
              </p>
              <p className="mt-0.5 truncate text-[9px] text-disabled tabular-nums">
                {selection.clip.id}
              </p>
            </div>
            {matchesInspectorQuery(
              query,
              "timing",
              "timeline start",
              "duration",
              "source in",
              "source out",
            ) && (
              <InspectorGroup title="Timing" forceOpen={query.length > 0}>
                <ReadonlyField
                  label="Timeline start"
                  value={formatDuration(timeUs(selection.clip.timelineStartUs))}
                />
                <ReadonlyField
                  label="Duration"
                  value={formatDuration(timeUs(selection.clip.durationUs))}
                />
                <ReadonlyField
                  label="Source in"
                  value={formatDuration(timeUs(selection.clip.sourceStartUs))}
                />
                <ReadonlyField
                  label="Source out"
                  value={formatDuration(
                    timeUs(
                      selection.clip.sourceStartUs +
                        Math.round(selection.clip.durationUs * selection.clip.playbackRate),
                    ),
                  )}
                />
              </InspectorGroup>
            )}
            <SemanticControls
              generation={session.generation}
              nodeId={selection.clip.id}
              bindings={session.editMap.nodes[selection.clip.id]}
              schema={session.propertySchemas.clip?.properties}
              include={CLIP_INSPECTOR_PROPERTIES}
              query={query}
              onCommit={(property, value) =>
                void execute({
                  type: "property.set",
                  nodeId: selection.clip.id,
                  property,
                  value,
                  scope: "instance",
                })
              }
            />
            {selection.content && (
              <SceneControls
                generation={session.generation}
                node={selection.content}
                editMap={session.editMap.nodes}
                schemas={session.propertySchemas}
                query={query}
                onCommit={(nodeId, property, value) =>
                  void execute({
                    type: "property.set",
                    nodeId,
                    property,
                    value,
                    scope: "instance",
                  })
                }
              />
            )}
            {asset &&
              matchesInspectorQuery(query, "source", "resolution", "frame rate", "audio") && (
                <InspectorGroup title="Source" forceOpen={query.length > 0}>
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
              )}
            {!hasMatches && (
              <p className="px-2 py-8 text-center text-ui-xs text-muted">
                No properties match “{query.trim()}”
              </p>
            )}
          </div>
        ) : (
          <Empty className="h-44">
            <EmptyHeader>
              <EmptyIcon className="mb-2">
                <SlidersHorizontal size={21} />
              </EmptyIcon>
              <EmptyTitle>Select a clip</EmptyTitle>
              <EmptyDescription>Its source-backed properties will appear here</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </aside>
  );
}
