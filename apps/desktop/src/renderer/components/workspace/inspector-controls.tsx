import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ChevronRight, cn } from "@cinesim/ui";
import type { PropertySchema } from "@cinesim/compiler";
import type { IrEditMapNode, IrSceneNode, IrValue } from "@cinesim/ir";
import type { DesktopProjectSession } from "../../../shared/contracts";
import {
  groupLabel,
  inspectorPropertyLabel,
  matchesInspectorQuery,
  printInspectorValue,
  propertyMatchesQuery,
  sceneMatchesInspectorQuery,
} from "./inspector-model";

interface NumericScrub {
  pointerId: number;
  startValue: number;
  startX: number;
}

export function SceneControls({
  generation,
  node,
  editMap,
  schemas,
  query,
  onCommit,
}: {
  generation: string;
  node: IrSceneNode;
  editMap: Record<string, IrEditMapNode>;
  schemas: DesktopProjectSession["propertySchemas"];
  query: string;
  onCommit: (nodeId: string, property: string, value: IrValue) => void;
}) {
  const nodeMatches = matchesInspectorQuery(query, node.kind, node.id);
  if (!sceneMatchesInspectorQuery(node, editMap, schemas, query)) return null;
  return (
    <InspectorGroup
      title={`${groupLabel(node.kind)} · ${node.id}`}
      compact
      forceOpen={query.length > 0}
    >
      <SemanticControls
        generation={generation}
        nodeId={node.id}
        bindings={editMap[node.id]}
        schema={schemas[node.kind]?.properties}
        query={nodeMatches ? "" : query}
        onCommit={(property, value) => onCommit(node.id, property, value)}
      />
      {node.children.map((child) => (
        <SceneControls
          key={child.id}
          generation={generation}
          node={child}
          editMap={editMap}
          schemas={schemas}
          query={query}
          onCommit={onCommit}
        />
      ))}
    </InspectorGroup>
  );
}

export function SemanticControls({
  generation,
  nodeId,
  bindings,
  schema,
  include,
  query,
  onCommit,
}: {
  generation: string;
  nodeId: string;
  bindings?: IrEditMapNode | undefined;
  schema?: Record<string, PropertySchema> | undefined;
  include?: ReadonlySet<string> | undefined;
  query: string;
  onCommit: (property: string, value: IrValue) => void;
}) {
  if (!bindings || !schema) return null;
  const properties = Object.values(schema).filter(
    (property) =>
      (!include || include.has(property.name)) &&
      property.name !== "id" &&
      bindings.properties[property.name] !== undefined &&
      propertyMatchesQuery(property, query),
  );
  const groups = properties.reduce<Map<string, PropertySchema[]>>((result, property) => {
    const group = result.get(property.group) ?? [];
    group.push(property);
    result.set(property.group, group);
    return result;
  }, new Map());
  return [...groups].map(([group, entries]) => (
    <InspectorGroup
      key={`${nodeId}-${group}`}
      title={groupLabel(group)}
      forceOpen={query.length > 0}
    >
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
      <p className="truncate px-1 pt-1 text-[9px] text-disabled">
        {bindings.structural.element.uri}:{bindings.structural.element.start.line}
        {bindings.structural.kind === "generated" ? " · generated/read-only" : ""}
      </p>
    </InspectorGroup>
  ));
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
      <div className="grid min-h-7 grid-cols-[88px_1fr] items-center gap-2 px-1 text-ui-xs">
        <span className="text-muted">{inspectorPropertyLabel(property)}</span>
        <button
          type="button"
          role="switch"
          aria-label={`${inspectorPropertyLabel(property)}: ${value.value ? "on" : "off"}`}
          aria-checked={value.value}
          disabled={disabled}
          className={cn(
            "relative h-4 w-7 justify-self-end rounded-full bg-border-strong outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40",
            value.value && "bg-accent",
          )}
          onClick={() => onCommit({ ...value, value: !value.value })}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform",
              value.value && "translate-x-3",
            )}
          />
        </button>
      </div>
    );
  }
  if (value.kind === "resource" || value.kind === "rectangle" || value.kind === "vector") {
    return (
      <ReadonlyField label={inspectorPropertyLabel(property)} value={printInspectorValue(value)} />
    );
  }
  const scalar = value.kind === "time" ? value.valueUs : value.value;
  if (typeof scalar === "number" && value.kind !== "time") {
    return (
      <NumericPropertyControl
        property={property}
        value={value}
        scalar={scalar}
        disabled={disabled}
        onCommit={onCommit}
      />
    );
  }
  const commit = (raw: string) => {
    if (value.kind === "time") return;
    onCommit({ ...value, value: raw } as IrValue);
  };
  return (
    <div className="grid min-h-7 grid-cols-[88px_1fr] items-center gap-2 px-1 text-ui-xs">
      <span className="text-muted">{inspectorPropertyLabel(property)}</span>
      {property.options ? (
        <select
          className="h-7 min-w-0 rounded border border-border bg-panel-muted px-1.5 text-secondary outline-none focus:border-border-strong"
          defaultValue={String(scalar)}
          disabled={disabled}
          onChange={(event) => commit(event.currentTarget.value)}
        >
          {property.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          className="h-7 min-w-0 rounded border border-border bg-panel-muted px-1.5 text-secondary outline-none focus:border-border-strong"
          type="text"
          defaultValue={String(scalar)}
          disabled={disabled || value.kind === "time"}
          onBlur={(event) => {
            if (event.currentTarget.value !== String(scalar)) commit(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    </div>
  );
}

function NumericPropertyControl({
  property,
  value,
  scalar,
  disabled,
  onCommit,
}: {
  property: PropertySchema;
  value: Exclude<IrValue, { kind: "time" }>;
  scalar: number;
  disabled: boolean;
  onCommit: (value: IrValue) => void;
}) {
  const [draft, setDraft] = useState(String(scalar));
  const scrubRef = useRef<NumericScrub | null>(null);
  const step = property.step ?? 1;
  const commit = (next: number) => {
    if (!Number.isFinite(next) || next === scalar || !("value" in value)) return;
    onCommit({ ...value, value: next } as IrValue);
  };
  const onScrubStart = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    scrubRef.current = {
      pointerId: event.pointerId,
      startValue: Number(draft),
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onScrubMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    const precision = Math.max(0, String(step).split(".")[1]?.length ?? 0);
    setDraft((scrub.startValue + (event.clientX - scrub.startX) * step).toFixed(precision));
  };
  const onScrubEnd = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const precision = Math.max(0, String(step).split(".")[1]?.length ?? 0);
    const next = Number(
      (scrub.startValue + (event.clientX - scrub.startX) * step).toFixed(precision),
    );
    setDraft(String(next));
    commit(next);
  };
  const onScrubCancel = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (scrubRef.current?.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    setDraft(String(scalar));
  };
  return (
    <div className="grid min-h-7 grid-cols-[88px_1fr] items-center gap-2 px-1 text-ui-xs">
      <span
        className={cn("select-none text-muted", !disabled && "cursor-ew-resize hover:text-primary")}
        title={disabled ? undefined : "Drag to adjust"}
        onPointerDown={onScrubStart}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubEnd}
        onPointerCancel={onScrubCancel}
      >
        {inspectorPropertyLabel(property)}
      </span>
      <input
        className="h-7 min-w-0 rounded border border-border bg-panel-muted px-1.5 text-right text-secondary tabular-nums outline-none focus:border-border-strong"
        type="number"
        value={draft}
        disabled={disabled}
        step={step}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => commit(Number(draft))}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(String(scalar));
        }}
      />
    </div>
  );
}

export function InspectorGroup({
  title,
  children,
  compact = false,
  defaultOpen = true,
  forceOpen = false,
}: {
  title: string;
  children: ReactNode;
  compact?: boolean;
  defaultOpen?: boolean;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="group border-b border-border/70 last:border-b-0"
      open={forceOpen || open}
      onToggle={(event) => {
        if (!forceOpen) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className={cn(
          "flex h-8 cursor-pointer list-none items-center gap-1.5 px-1 text-[11px] font-semibold text-secondary outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden",
          compact && "text-[10px] font-medium text-muted",
        )}
      >
        <ChevronRight size={12} className="shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 truncate">{title}</span>
      </summary>
      <div className="space-y-1 pb-2">{children}</div>
    </details>
  );
}

export function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-7 grid-cols-[88px_1fr] items-center gap-2 px-1 text-ui-xs">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate rounded bg-panel-muted px-1.5 py-1 text-secondary">
        {value}
      </span>
    </div>
  );
}
