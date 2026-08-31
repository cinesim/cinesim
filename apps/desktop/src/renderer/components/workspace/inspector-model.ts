import { timeUs } from "@cinesim/core";
import type { PropertySchema } from "@cinesim/compiler";
import type { IrClip, IrEditMapNode, IrSceneNode, IrValue } from "@cinesim/ir";
import type { DesktopProjectSession } from "../../../shared/contracts";
import { formatDuration } from "../../lib/format";

export interface SemanticSelection {
  clip: IrClip;
  content?: IrSceneNode;
}

export const CLIP_INSPECTOR_PROPERTIES = new Set([
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

export function selectedSemanticClip(
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

export function matchesInspectorQuery(query: string, ...terms: Array<string | undefined>): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    terms.some((term) => term?.toLocaleLowerCase().includes(normalized) === true)
  );
}

export function propertyMatchesQuery(property: PropertySchema, query: string): boolean {
  const alias = property.name === "x" || property.name === "y" ? "position" : undefined;
  return matchesInspectorQuery(
    query,
    inspectorPropertyLabel(property),
    property.name,
    property.group,
    alias,
  );
}

export function inspectorPropertyLabel(property: PropertySchema): string {
  if (property.name === "x") return "Position X";
  if (property.name === "y") return "Position Y";
  return property.label;
}

export function sceneMatchesInspectorQuery(
  node: IrSceneNode,
  editMap: Record<string, IrEditMapNode>,
  schemas: DesktopProjectSession["propertySchemas"],
  query: string,
): boolean {
  if (matchesInspectorQuery(query, node.kind, node.id)) return true;
  const bindings = editMap[node.id];
  const ownProperties = schemas[node.kind]?.properties;
  if (
    bindings &&
    ownProperties &&
    Object.values(ownProperties).some(
      (property) =>
        bindings.properties[property.name] !== undefined && propertyMatchesQuery(property, query),
    )
  )
    return true;
  return node.children.some((child) => sceneMatchesInspectorQuery(child, editMap, schemas, query));
}

export function inspectorSelectionMatches(
  session: DesktopProjectSession,
  selection: SemanticSelection,
  hasAsset: boolean,
  query: string,
): boolean {
  if (query.trim().length === 0) return true;
  if (
    matchesInspectorQuery(query, "timing", "timeline start", "duration", "source in", "source out")
  )
    return true;
  const bindings = session.editMap.nodes[selection.clip.id];
  const clipProperties = session.propertySchemas.clip?.properties;
  if (
    bindings &&
    clipProperties &&
    Object.values(clipProperties).some(
      (property) =>
        CLIP_INSPECTOR_PROPERTIES.has(property.name) &&
        bindings.properties[property.name] !== undefined &&
        propertyMatchesQuery(property, query),
    )
  )
    return true;
  if (
    selection.content &&
    sceneMatchesInspectorQuery(
      selection.content,
      session.editMap.nodes,
      session.propertySchemas,
      query,
    )
  )
    return true;
  return hasAsset && matchesInspectorQuery(query, "source", "resolution", "frame rate", "audio");
}

export function groupLabel(group: string): string {
  return group.slice(0, 1).toUpperCase() + group.slice(1);
}

export function printInspectorValue(value: IrValue): string {
  if (value.kind === "resource") return value.assetId;
  if (value.kind === "rectangle" || value.kind === "vector") return value.values.join(", ");
  if (value.kind === "time") return formatDuration(timeUs(value.valueUs));
  return String(value.value);
}
