import { SlidersHorizontal } from "@cinesim/ui";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
  SectionHeading,
} from "@cinesim/ui";
import { timeUs } from "@cinesim/core";
import type { PropertySchema } from "@cinesim/compiler";
import type { IrClip, IrEditMapNode, IrSceneNode, IrValue } from "@cinesim/ir";
import type { DesktopProjectSession } from "../../../shared/contracts";
import { formatDuration } from "../../lib/format";
import { useRendererStore } from "../../store/renderer-store-context";

interface SemanticSelection {
  clip: IrClip;
  content?: IrSceneNode;
}

function selectedSemanticClip(
  session: DesktopProjectSession,
  selectedClipId: string | null,
): SemanticSelection | null {
  if (!selectedClipId) return null;
  const clip = session.program.compositions
    .flatMap((composition) => composition.timeline.tracks)
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === selectedClipId);
  if (!clip) return null;
  return { clip, ...(clip.content ? { content: clip.content } : {}) };
}

const CLIP_INSPECTOR_PROPERTIES = new Set([
  "enabled",
  "x",
  "y",
  "scaleX",
  "scaleY",
  "rotation",
  "opacity",
  "gain",
  "pan",
  "muted",
]);

export function Inspector({ session }: { session: DesktopProjectSession }) {
  const execute = useRendererStore((state) => state.execute);
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const selection = selectedSemanticClip(session, selectedClipId);
  const asset = selection?.clip.assetId
    ? session.project.assets.find((candidate) => candidate.id === selection.clip.assetId)
    : null;

  return (
    <aside className="flex min-h-0 flex-col bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selection ? (
          <div className="space-y-5">
            <div>
              <p className="truncate text-ui font-medium text-primary">
                {asset?.name ?? selection.clip.name ?? "Generated clip"}
              </p>
              <p className="mt-1 text-ui-xs text-muted tabular-nums">{selection.clip.id}</p>
            </div>
            <InspectorGroup title="Timing">
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
            <SemanticControls
              generation={session.generation}
              nodeId={selection.clip.id}
              bindings={session.editMap.nodes[selection.clip.id]}
              schema={session.propertySchemas.clip?.properties}
              include={CLIP_INSPECTOR_PROPERTIES}
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
            {asset && (
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

function SceneControls({
  generation,
  node,
  editMap,
  schemas,
  onCommit,
}: {
  generation: string;
  node: IrSceneNode;
  editMap: Record<string, IrEditMapNode>;
  schemas: DesktopProjectSession["propertySchemas"];
  onCommit: (nodeId: string, property: string, value: IrValue) => void;
}) {
  return (
    <div className="space-y-4 border-l border-border pl-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
        {node.kind} · {node.id}
      </p>
      <SemanticControls
        generation={generation}
        nodeId={node.id}
        bindings={editMap[node.id]}
        schema={schemas[node.kind]?.properties}
        onCommit={(property, value) => onCommit(node.id, property, value)}
      />
      {node.children.map((child) => (
        <SceneControls
          key={child.id}
          generation={generation}
          node={child}
          editMap={editMap}
          schemas={schemas}
          onCommit={onCommit}
        />
      ))}
    </div>
  );
}

function SemanticControls({
  generation,
  nodeId,
  bindings,
  schema,
  include,
  onCommit,
}: {
  generation: string;
  nodeId: string;
  bindings?: IrEditMapNode | undefined;
  schema?: Record<string, PropertySchema> | undefined;
  include?: ReadonlySet<string> | undefined;
  onCommit: (property: string, value: IrValue) => void;
}) {
  if (!bindings || !schema) return null;
  const properties = Object.values(schema).filter(
    (property) =>
      (!include || include.has(property.name)) &&
      property.name !== "id" &&
      bindings.properties[property.name] !== undefined,
  );
  if (properties.length === 0) return null;
  const groups = properties.reduce<Map<string, PropertySchema[]>>((result, property) => {
    const group = result.get(property.group) ?? [];
    group.push(property);
    result.set(property.group, group);
    return result;
  }, new Map());
  return [...groups].map(([group, entries]) => (
    <InspectorGroup key={`${nodeId}-${group}`} title={groupLabel(group)}>
      {entries.map((property) => {
        const binding = bindings.properties[property.name]!;
        return (
          <PropertyControl
            key={`${nodeId}-${property.name}-${generation}`}
            property={property}
            value={binding.value}
            disabled={binding.scopes.length === 0}
            onCommit={(value) => onCommit(property.name, value)}
          />
        );
      })}
      <p className="pt-1 text-[10px] text-muted">
        Source: {bindings.structural.element.uri}:{bindings.structural.element.start.line}
        {bindings.structural.kind === "generated" ? " · generated/read-only" : ""}
      </p>
    </InspectorGroup>
  ));
}

function groupLabel(group: string): string {
  return group.slice(0, 1).toUpperCase() + group.slice(1);
}

function PropertyControl({
  property,
  value,
  disabled,
  onCommit,
}: {
  property: PropertySchema;
  value: IrValue;
  disabled: boolean;
  onCommit: (value: IrValue) => void;
}) {
  if (value.kind === "boolean") {
    return (
      <label className="grid grid-cols-[84px_1fr] items-center text-ui-xs">
        <span className="text-muted">{property.label}</span>
        <input
          type="checkbox"
          defaultChecked={value.value}
          disabled={disabled}
          onChange={(event) => onCommit({ ...value, value: event.currentTarget.checked })}
        />
      </label>
    );
  }
  if (value.kind === "resource" || value.kind === "rectangle" || value.kind === "vector") {
    return <ReadonlyField label={property.label} value={printValue(value)} />;
  }
  const scalar = value.kind === "time" ? value.valueUs : value.value;
  const numeric = typeof scalar === "number";
  const options = property.options;
  const commit = (raw: string) => {
    if (value.kind === "time") return;
    onCommit({ ...value, value: numeric ? Number(raw) : raw } as IrValue);
  };
  return (
    <label className="grid grid-cols-[84px_1fr] items-center text-ui-xs">
      <span className="text-muted">{property.label}</span>
      {options ? (
        <select
          className="rounded border border-border bg-panel-muted px-2 py-1.5 text-secondary"
          defaultValue={String(scalar)}
          disabled={disabled}
          onChange={(event) => commit(event.currentTarget.value)}
        >
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          className="min-w-0 rounded border border-border bg-panel-muted px-2 py-1.5 text-secondary"
          type={numeric ? "number" : "text"}
          defaultValue={String(scalar)}
          disabled={disabled || value.kind === "time"}
          step={property.step}
          onBlur={(event) => {
            if (event.currentTarget.value !== String(scalar)) commit(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

function printValue(value: IrValue): string {
  if (value.kind === "resource") return value.assetId;
  if (value.kind === "rectangle" || value.kind === "vector") return value.values.join(", ");
  if (value.kind === "time") return formatDuration(timeUs(value.valueUs));
  return String(value.value);
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
