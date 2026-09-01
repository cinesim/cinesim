import type {
  IrAnimation,
  IrClip,
  IrComposition,
  IrEffect,
  IrSceneNode,
  IrTrack,
  IrValue,
} from "@cinesim/ir";
import { fail } from "./compiler-errors";
import type { BoundAnimation, BoundNode } from "./compiler-model";
import { booleanValue, numberValue, propertyValue, stringValue, timeValue } from "./expressions";
import { displayLocation } from "./jsx-syntax";
import { EFFECT_BUILTINS } from "./registry";
import type { CompilerExplanation } from "./types";

const TRACK_KINDS = new Set(["video", "audio", "overlay"]);
const MEDIA_KINDS = new Set(["video", "audio"]);
const TRANSITIONS = new Set(["cut", "dissolve", "dip", "wipe", "slide", "push", "zoom", "blur"]);

function runtimeAnimation(animation: BoundAnimation): IrAnimation {
  return {
    property: animation.property,
    keyframes: animation.keyframes.map((keyframe) => ({
      at: keyframe.at,
      value: keyframe.value,
      easing: keyframe.easing,
    })),
  };
}

function lowerEffect(node: BoundNode): IrEffect {
  return {
    id: node.id,
    kind: node.kind as IrEffect["kind"],
    enabled: booleanValue(node, "enabled", true),
    props: Object.fromEntries(
      Object.entries(node.props)
        .filter(([name]) => name !== "enabled")
        .map(([name, property]) => [name, property.value]),
    ),
    children: node.children.filter((child) => !EFFECT_BUILTINS.has(child.kind)).map(lowerSceneNode),
  };
}

function lowerSceneNode(node: BoundNode): IrSceneNode {
  return {
    id: node.id,
    kind: node.kind,
    props: Object.fromEntries(
      Object.entries(node.props).map(([name, property]) => [name, property.value]),
    ),
    animations: node.animations.map(runtimeAnimation),
    effects: node.children.filter((child) => EFFECT_BUILTINS.has(child.kind)).map(lowerEffect),
    children: node.children.filter((child) => !EFFECT_BUILTINS.has(child.kind)).map(lowerSceneNode),
  };
}

function lowerClipContent(node: BoundNode): IrSceneNode | undefined {
  const children = node.children.filter((child) => !EFFECT_BUILTINS.has(child.kind));
  if (children.length === 0) return undefined;
  if (children.length === 1) return lowerSceneNode(children[0]!);
  return {
    id: `${node.id}/content`,
    kind: "group",
    props: {},
    animations: [],
    effects: [],
    children: children.map(lowerSceneNode),
  };
}

function lowerTransform(node: BoundNode): IrClip["transform"] {
  const scale = numberValue(node, "scale", 1);
  const crop = propertyValue(node, "crop");
  return {
    x: numberValue(node, "x", 0),
    y: numberValue(node, "y", 0),
    ...(propertyValue(node, "width") === undefined ? {} : { width: numberValue(node, "width", 0) }),
    ...(propertyValue(node, "height") === undefined
      ? {}
      : { height: numberValue(node, "height", 0) }),
    anchorX: numberValue(node, "anchorX", 50),
    anchorY: numberValue(node, "anchorY", 50),
    scaleX: numberValue(node, "scaleX", scale),
    scaleY: numberValue(node, "scaleY", scale),
    rotation: numberValue(node, "rotation", 0),
    opacity: numberValue(node, "opacity", 1),
    zIndex: numberValue(node, "z", 0),
    fit: stringValue(node, "fit", "contain") as "contain" | "cover" | "fill",
    ...(crop?.kind === "rectangle" ? { crop: crop.values } : {}),
    cornerRadius: numberValue(node, "cornerRadius", 0),
    blendMode: stringValue(node, "blendMode", "normal"),
  };
}

function lowerClip(node: BoundNode, trackId: string): IrClip {
  const asset = propertyValue(node, "asset");
  const media = propertyValue(node, "media");
  const linked = propertyValue(node, "linked");
  const composition = propertyValue(node, "composition");
  const content = lowerClipContent(node);
  return {
    id: node.id,
    trackId,
    ...(propertyValue(node, "name") === undefined ? {} : { name: stringValue(node, "name") }),
    ...(asset?.kind === "resource" ? { assetId: asset.assetId } : {}),
    ...(composition?.kind === "string" ? { compositionId: composition.value } : {}),
    ...(media?.kind === "string" && MEDIA_KINDS.has(media.value)
      ? { mediaKind: media.value as "video" | "audio" }
      : {}),
    ...(linked?.kind === "string" ? { linkedClipId: linked.value } : {}),
    timelineStartUs: timeValue(node, "start"),
    sourceStartUs: timeValue(node, "in"),
    durationUs: timeValue(node, "duration"),
    playbackRate: numberValue(node, "playbackRate", 1),
    enabled: booleanValue(node, "enabled", true),
    reverse: booleanValue(node, "reverse", false),
    freeze: booleanValue(node, "freeze", false),
    loop: booleanValue(node, "loop", false),
    fades: { inUs: timeValue(node, "fadeIn"), outUs: timeValue(node, "fadeOut") },
    transform: lowerTransform(node),
    audio: {
      gainDb: numberValue(node, "gain", 0),
      pan: numberValue(node, "pan", 0),
      muted: booleanValue(node, "muted", false),
    },
    ...(content === undefined ? {} : { content }),
    effects: node.children.filter((child) => EFFECT_BUILTINS.has(child.kind)).map(lowerEffect),
  };
}

function lowerTrack(node: BoundNode): IrTrack {
  const kind = stringValue(node, "kind");
  if (!TRACK_KINDS.has(kind)) fail("TRACK_KIND", `Invalid track kind ${kind}.`, node.origin);
  return {
    id: node.id,
    kind: kind as IrTrack["kind"],
    name: stringValue(node, "name"),
    muted: booleanValue(node, "muted", false),
    locked: booleanValue(node, "locked", false),
    clips: node.children
      .filter((child) => child.kind === "clip")
      .map((clip) => lowerClip(clip, node.id)),
    effects: node.children.filter((child) => EFFECT_BUILTINS.has(child.kind)).map(lowerEffect),
  };
}

function lowerTransitions(timeline: BoundNode): IrComposition["timeline"]["transitions"] {
  return timeline.children
    .filter((child) => child.kind === "transition")
    .map((transition) => {
      const kind = stringValue(transition, "kind");
      if (!TRANSITIONS.has(kind)) {
        fail("TRANSITION_KIND", `Invalid transition kind ${kind}.`, transition.origin);
      }
      return {
        id: transition.id,
        fromClipId: stringValue(transition, "from"),
        toClipId: stringValue(transition, "to"),
        kind: kind as "cut",
        durationUs: timeValue(transition, "duration"),
        props: {},
      };
    });
}

function lowerComposition(node: BoundNode): IrComposition {
  const timeline = node.children.find((child) => child.kind === "timeline");
  if (!timeline) {
    fail("TIMELINE_REQUIRED", `Composition ${node.id} requires one timeline.`, node.origin);
  }
  const extra = node.children.find((child) => child.kind !== "timeline");
  if (extra) fail("COMPOSITION_CHILD", "Composition may only contain a timeline.", extra.origin);
  const markers = timeline.children
    .filter((child) => child.kind === "marker")
    .map((marker) => ({
      id: marker.id,
      atUs: timeValue(marker, "at"),
      name: stringValue(marker, "name"),
      ...(propertyValue(marker, "color")?.kind === "color"
        ? { color: stringValue(marker, "color") }
        : {}),
    }));
  const notes: IrComposition["timeline"]["notes"] = timeline.children
    .filter((child) => child.kind === "note")
    .map((note) => {
      const kind = stringValue(note, "kind");
      if (
        ![
          "story-intent",
          "scene",
          "continuity",
          "edit-task",
          "review-feedback",
          "general",
        ].includes(kind)
      )
        fail("NOTE_KIND", `Invalid note kind ${kind}.`, note.origin);
      return {
        id: note.id,
        atUs: timeValue(note, "at"),
        ...(propertyValue(note, "duration") === undefined
          ? {}
          : { durationUs: timeValue(note, "duration") }),
        kind: kind as IrComposition["timeline"]["notes"][number]["kind"],
        text: stringValue(note, "text"),
      };
    });
  const fps =
    propertyValue(node, "fps") === undefined
      ? numberValue(node, "frameRate", 0)
      : numberValue(node, "fps", 0);
  return {
    id: node.id,
    name: stringValue(node, "name", node.id),
    width: numberValue(node, "width", 0),
    height: numberValue(node, "height", 0),
    frameRate: fps,
    background: stringValue(node, "background", "#09090b"),
    timeline: {
      id: timeline.id,
      tracks: timeline.children.filter((child) => child.kind === "track").map(lowerTrack),
      notes,
      markers,
      transitions: lowerTransitions(timeline),
    },
  };
}

export function lowerCompositions(roots: readonly BoundNode[]): IrComposition[] {
  return roots.map(lowerComposition);
}

export function explainBoundNodes(roots: readonly BoundNode[]): CompilerExplanation[] {
  const result: CompilerExplanation[] = [];
  const visit = (current: BoundNode): void => {
    result.push({
      nodeId: current.id,
      kind: current.kind,
      definedAt: displayLocation(current.origin),
      expandedThrough: current.componentStack.map(
        (frame) => `${frame.name} invoked at ${displayLocation(frame.invocation)}`,
      ),
    });
    current.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}

function collectValues(values: Iterable<IrValue>, assets: Set<string>): void {
  for (const value of values) if (value.kind === "resource") assets.add(value.assetId);
}

function collectSceneAssets(node: IrSceneNode, assets: Set<string>): void {
  collectValues(Object.values(node.props), assets);
  for (const animation of node.animations) {
    collectValues(
      animation.keyframes.map((keyframe) => keyframe.value),
      assets,
    );
  }
  for (const effect of node.effects) {
    collectValues(Object.values(effect.props), assets);
    effect.children.forEach((child) => collectSceneAssets(child, assets));
  }
  node.children.forEach((child) => collectSceneAssets(child, assets));
}

export function referencedAssetIds(compositions: readonly IrComposition[]): string[] {
  const assets = new Set<string>();
  const clips = compositions.flatMap((composition) =>
    composition.timeline.tracks.flatMap((track) => track.clips),
  );
  for (const clip of clips) {
    if (clip.assetId !== undefined) assets.add(clip.assetId);
    if (clip.content) collectSceneAssets(clip.content, assets);
  }
  return [...assets].sort((left, right) => left.localeCompare(right));
}
