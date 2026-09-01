import { timeUs } from "@cinesim/core";
import type { Asset, TimeUs, Transform } from "@cinesim/core";
import { createRenderPlan, findIrComposition } from "@cinesim/ir";
import type {
  EvaluatedIrNode,
  IrClip,
  IrComposition,
  IrEffect,
  IrProgram,
  IrTrack,
  IrTransform,
  IrValue,
} from "@cinesim/ir";

export interface PlaybackProject {
  program: IrProgram;
  assets: readonly Asset[];
}

export interface ColorAdjustment {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  highlights?: number;
  shadows?: number;
}

export interface VisualEffectSettings {
  blurPx: number;
  chromaColor: readonly [number, number, number, number];
  chromaTolerance: number;
  vignetteAmount: number;
  vignetteSoftness: number;
  grainAmount: number;
  grainSize: number;
  shadowColor: readonly [number, number, number, number];
  shadowX: number;
  shadowY: number;
  shadowBlur: number;
}

export interface ResolvedLayer {
  asset: Asset;
  clip: IrClip;
  track: IrTrack;
  nodeId: string;
  sourceTimeUs: TimeUs;
  opacity: number;
  transform: Transform;
  cornerRadiusPx: number;
  colorAdjustment: ColorAdjustment;
  visualEffects?: VisualEffectSettings;
  transition?: {
    kind: "wipe" | "blur";
    progress: number;
    direction: "left" | "right" | "up" | "down";
    softness: number;
    intensity: number;
  };
  order: number;
}

export interface ResolvedGraphicLayer {
  nodeId: string;
  kind: "solid";
  transform: Transform;
  color: readonly [number, number, number, number];
  cornerRadiusPx: number;
  blurPx: number;
  order: number;
}

export interface ResolvedTextLayer {
  nodeId: string;
  text: string;
  originX: number;
  originY: number;
  maxWidth: number;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  color: readonly [number, number, number, number];
  outlineColor: readonly [number, number, number, number];
  outlineWidth: number;
  shadowColor: readonly [number, number, number, number];
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  opacity: number;
  scale: number;
  rotation: number;
  emphasis?: {
    start: number;
    end: number;
    color: readonly [number, number, number, number];
    scale: number;
  };
  order: number;
}

export interface ResolvedScene {
  media: ResolvedLayer[];
  graphics: ResolvedGraphicLayer[];
  text: ResolvedTextLayer[];
  background: readonly [number, number, number, number];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutContext {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  available: Box;
  effects: readonly IrEffect[];
}

const DEFAULT_COLOR_ADJUSTMENT: ColorAdjustment = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
};

const DEFAULT_VISUAL_EFFECTS: VisualEffectSettings = {
  blurPx: 0,
  chromaColor: [0, 1, 0, 1],
  chromaTolerance: 0,
  vignetteAmount: 0,
  vignetteSoftness: 0.5,
  grainAmount: 0,
  grainSize: 1,
  shadowColor: [0, 0, 0, 0],
  shadowX: 0,
  shadowY: 0,
  shadowBlur: 0,
};

function numeric(value: IrValue | undefined, fallback: number): number {
  if (
    value?.kind === "number" ||
    value?.kind === "length" ||
    value?.kind === "percent" ||
    value?.kind === "angle"
  )
    return value.value;
  return fallback;
}

function stringValue(value: IrValue | undefined, fallback: string): string {
  return value?.kind === "string" || value?.kind === "color" ? value.value : fallback;
}

function resource(value: IrValue | undefined): string | undefined {
  return value?.kind === "resource" ? value.assetId : undefined;
}

function parseColor(value: string): readonly [number, number, number, number] {
  const hex = value.startsWith("#") ? value.slice(1) : value;
  const expanded =
    hex.length === 3 || hex.length === 4
      ? hex
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : hex;
  if (expanded.length !== 6 && expanded.length !== 8) return [1, 0, 1, 1];
  const channels = [0, 2, 4, 6].map((offset) =>
    offset < expanded.length ? Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255 : 1,
  );
  return channels as [number, number, number, number];
}

function normalizedTransform(
  box: Box,
  width: number,
  height: number,
  fit: Transform["fit"],
  opacity: number,
  outer: IrTransform,
): Transform {
  return {
    x: ((box.x + box.width / 2 + outer.x) / width) * 2 - 1,
    y: ((box.y + box.height / 2 + outer.y) / height) * 2 - 1,
    scaleX: (box.width / width) * outer.scaleX,
    scaleY: (box.height / height) * outer.scaleY,
    rotation: outer.rotation,
    opacity,
    fit,
  };
}

function directTransform(
  transform: IrTransform,
  opacity: number,
  output: { width: number; height: number },
): Transform {
  return {
    x: (transform.x / output.width) * 2,
    y: (transform.y / output.height) * 2,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: transform.rotation,
    opacity,
    fit: transform.fit,
  };
}

function colorAdjustment(effects: readonly IrEffect[]): ColorAdjustment {
  const adjustment = { ...DEFAULT_COLOR_ADJUSTMENT };
  for (const effect of effects) {
    if (!effect.enabled || effect.kind !== "colorgrade") continue;
    adjustment.exposure = numeric(effect.props.exposure, adjustment.exposure);
    adjustment.contrast = numeric(effect.props.contrast, adjustment.contrast);
    adjustment.saturation = numeric(effect.props.saturation, adjustment.saturation);
    adjustment.temperature = numeric(effect.props.temperature, adjustment.temperature);
    adjustment.tint = numeric(effect.props.tint, adjustment.tint);
    adjustment.highlights = numeric(effect.props.highlights, adjustment.highlights ?? 0);
    adjustment.shadows = numeric(effect.props.shadows, adjustment.shadows ?? 0);
  }
  return adjustment;
}

function applyVisualEffect(result: VisualEffectSettings, effect: IrEffect): void {
  switch (effect.kind) {
    case "blur":
      result.blurPx = Math.max(0, numeric(effect.props.radius, 0));
      break;
    case "chromakey":
      result.chromaColor = parseColor(stringValue(effect.props.color, "#00ff00"));
      result.chromaTolerance = Math.max(0, numeric(effect.props.tolerance, 0));
      break;
    case "vignette":
      result.vignetteAmount = Math.max(0, numeric(effect.props.amount, 0));
      result.vignetteSoftness = Math.max(0.001, numeric(effect.props.softness, 0.5));
      break;
    case "grain":
      result.grainAmount = Math.max(0, numeric(effect.props.amount, 0));
      result.grainSize = Math.max(0.1, numeric(effect.props.size, 1));
      break;
    case "shadow":
      result.shadowColor = parseColor(stringValue(effect.props.color, "#00000080"));
      result.shadowX = numeric(effect.props.x, 0);
      result.shadowY = numeric(effect.props.y, 0);
      result.shadowBlur = Math.max(0, numeric(effect.props.blur, 0));
      break;
  }
}

function visualEffects(effects: readonly IrEffect[]): VisualEffectSettings {
  const result = { ...DEFAULT_VISUAL_EFFECTS };
  for (const effect of effects) if (effect.enabled) applyVisualEffect(result, effect);
  return result;
}

function clipOpacity(clip: IrClip, timelineTimeUs: number): number {
  const elapsedUs = timelineTimeUs - clip.timelineStartUs;
  const remainingUs = clip.durationUs - elapsedUs;
  const fadeIn = clip.fades.inUs > 0 ? Math.min(1, elapsedUs / clip.fades.inUs) : 1;
  const fadeOut = clip.fades.outUs > 0 ? Math.min(1, remainingUs / clip.fades.outUs) : 1;
  return clip.transform.opacity * Math.max(0, Math.min(fadeIn, fadeOut));
}

interface ContentOutput {
  composition: { width: number; height: number };
  clip: IrClip;
  track: IrTrack;
  sourceTimeUs: TimeUs;
  assets: ReadonlyMap<string, Asset>;
  media: ResolvedLayer[];
  graphics: ResolvedGraphicLayer[];
  text: ResolvedTextLayer[];
  drawOrder: { value: number };
}

interface NodeLayout {
  scaleX: number;
  scaleY: number;
  nodeX: number;
  nodeY: number;
  opacity: number;
  effects: readonly IrEffect[];
}

function nodeLayout(node: EvaluatedIrNode, context: LayoutContext): NodeLayout {
  const nodeScale = numeric(node.props.scale, 1);
  return {
    scaleX: context.scaleX * nodeScale * numeric(node.props.scaleX, 1),
    scaleY: context.scaleY * nodeScale * numeric(node.props.scaleY, 1),
    nodeX: context.originX + numeric(node.props.x, 0) * context.scaleX,
    nodeY: context.originY + numeric(node.props.y, 0) * context.scaleY,
    opacity: context.opacity * numeric(node.props.opacity, 1),
    effects: [...context.effects, ...node.effects],
  };
}

function contentBox(
  node: EvaluatedIrNode,
  context: LayoutContext,
  layout: NodeLayout,
  forcedBox?: Box,
): Box {
  return (
    forcedBox ?? {
      x: layout.nodeX,
      y: layout.nodeY,
      width:
        numeric(node.props.width, context.available.width / Math.max(context.scaleX, 0.001)) *
        layout.scaleX,
      height:
        numeric(node.props.height, context.available.height / Math.max(context.scaleY, 0.001)) *
        layout.scaleY,
    }
  );
}

function childLayoutContext(layout: NodeLayout, available: Box): LayoutContext {
  return {
    originX: layout.nodeX,
    originY: layout.nodeY,
    scaleX: layout.scaleX,
    scaleY: layout.scaleY,
    opacity: layout.opacity,
    available,
    effects: layout.effects,
  };
}

function resolveStack(
  node: EvaluatedIrNode,
  context: LayoutContext,
  layout: NodeLayout,
  available: Box,
  output: ContentOutput,
): void {
  const gap = numeric(node.props.gap, 0) * layout.scaleY;
  const horizontal = stringValue(node.props.direction, "vertical") === "horizontal";
  const childContext = childLayoutContext(layout, available);
  let cursor = 0;
  for (const child of node.children) {
    const box = {
      x: available.x + (horizontal ? cursor : 0),
      y: available.y + (horizontal ? 0 : cursor),
      width:
        numeric(child.props.width, available.width / Math.max(layout.scaleX, 0.001)) *
        layout.scaleX,
      height:
        numeric(child.props.height, available.height / Math.max(layout.scaleY, 0.001)) *
        layout.scaleY,
    };
    resolveContent(child, childContext, box, output);
    cursor += (horizontal ? box.width : box.height) + gap;
  }
}

function resolveContainer(
  node: EvaluatedIrNode,
  context: LayoutContext,
  layout: NodeLayout,
  output: ContentOutput,
): void {
  const available = contentBox(node, context, layout);
  if (node.kind === "stack") return resolveStack(node, context, layout, available, output);
  const childContext = childLayoutContext(layout, available);
  node.children.forEach((child) => resolveContent(child, childContext, undefined, output));
}

function resolveGrid(
  node: EvaluatedIrNode,
  context: LayoutContext,
  layout: NodeLayout,
  forcedBox: Box | undefined,
  output: ContentOutput,
): void {
  const area: Box = forcedBox ?? {
    x: layout.nodeX,
    y: layout.nodeY,
    width: numeric(node.props.width, context.available.width) * context.scaleX,
    height: numeric(node.props.height, context.available.height) * context.scaleY,
  };
  const columns = Math.max(1, Math.floor(numeric(node.props.columns, 1)));
  const rows = Math.max(
    1,
    Math.floor(numeric(node.props.rows, Math.ceil(node.children.length / columns))),
  );
  const gapX = numeric(node.props.columnGap, numeric(node.props.gap, 0)) * context.scaleX;
  const gapY = numeric(node.props.rowGap, numeric(node.props.gap, 0)) * context.scaleY;
  const cellWidth = Math.max(0, (area.width - gapX * (columns - 1)) / columns);
  const cellHeight = Math.max(0, (area.height - gapY * (rows - 1)) / rows);
  const childContext = {
    ...childLayoutContext(layout, area),
    originX: area.x,
    originY: area.y,
  };
  node.children.slice(0, columns * rows).forEach((child, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    resolveContent(
      child,
      childContext,
      {
        x: area.x + column * (cellWidth + gapX),
        y: area.y + row * (cellHeight + gapY),
        width: cellWidth,
        height: cellHeight,
      },
      output,
    );
  });
}

function resolveMediaNode(
  node: EvaluatedIrNode,
  box: Box,
  layout: NodeLayout,
  output: ContentOutput,
): void {
  const assetId = resource(node.props.source);
  const asset = assetId === undefined ? undefined : output.assets.get(assetId);
  if (!asset || asset.kind === "audio") return;
  output.media.push({
    asset,
    clip: output.clip,
    track: output.track,
    nodeId: node.id,
    sourceTimeUs: output.sourceTimeUs,
    opacity: layout.opacity,
    transform: normalizedTransform(
      box,
      output.composition.width,
      output.composition.height,
      stringValue(node.props.fit, "contain") as Transform["fit"],
      layout.opacity,
      output.clip.transform,
    ),
    cornerRadiusPx: numeric(node.props.radius, numeric(node.props.cornerRadius, 0)),
    colorAdjustment: colorAdjustment(layout.effects),
    visualEffects: visualEffects(layout.effects),
    order: output.drawOrder.value++,
  });
}

function resolveShape(
  node: EvaluatedIrNode,
  box: Box,
  layout: NodeLayout,
  output: ContentOutput,
): void {
  output.graphics.push({
    nodeId: node.id,
    kind: "solid",
    transform: normalizedTransform(
      box,
      output.composition.width,
      output.composition.height,
      "fill",
      layout.opacity,
      output.clip.transform,
    ),
    color: parseColor(stringValue(node.props.fill, "#ffffff")),
    cornerRadiusPx:
      node.kind === "ellipse"
        ? Math.min(box.width, box.height) / 2
        : numeric(node.props.radius, numeric(node.props.cornerRadius, 0)),
    blurPx: numeric(node.props.blur, 0),
    order: output.drawOrder.value++,
  });
}

function resolveText(
  node: EvaluatedIrNode,
  box: Box,
  layout: NodeLayout,
  output: ContentOutput,
): void {
  const outer = output.clip.transform;
  const fontSize = Math.max(1, numeric(node.props.fontSize, 32) * layout.scaleY * outer.scaleY);
  output.text.push({
    nodeId: node.id,
    text: stringValue(node.props.text, ""),
    originX: box.x + outer.x,
    originY: box.y + outer.y,
    maxWidth:
      numeric(node.props.maxWidth, box.width) * Math.max(0.001, layout.scaleX * outer.scaleX),
    fontSize,
    fontWeight: numeric(node.props.fontWeight, 600),
    lineHeight: numeric(node.props.lineHeight, 1.15),
    letterSpacing: numeric(node.props.letterSpacing, 0) * layout.scaleX * outer.scaleX,
    align: stringValue(node.props.align, "left") as ResolvedTextLayer["align"],
    color: parseColor(stringValue(node.props.color, stringValue(node.props.fill, "#ffffff"))),
    outlineColor: parseColor(stringValue(node.props.stroke, "#00000000")),
    outlineWidth: numeric(node.props.outlineWidth, 0),
    shadowColor: [0, 0, 0, 0],
    shadowBlur: 0,
    shadowX: 0,
    shadowY: 0,
    opacity: layout.opacity,
    scale: 1,
    rotation: outer.rotation,
    order: output.drawOrder.value++,
  });
}

function resolveContent(
  node: EvaluatedIrNode,
  context: LayoutContext,
  forcedBox: Box | undefined,
  output: ContentOutput,
): void {
  const layout = nodeLayout(node, context);
  if (node.kind === "group" || node.kind === "mask" || node.kind === "stack") {
    return resolveContainer(node, context, layout, output);
  }
  if (node.kind === "grid") return resolveGrid(node, context, layout, forcedBox, output);
  const box = contentBox(node, context, layout, forcedBox);
  if (node.kind === "video" || node.kind === "image") {
    return resolveMediaNode(node, box, layout, output);
  }
  if (node.kind === "rect" || node.kind === "ellipse") {
    return resolveShape(node, box, layout, output);
  }
  if (node.kind === "text" || node.kind === "captions" || node.kind === "span") {
    resolveText(node, box, layout, output);
  }
}

export function compositionDurationUs(project: PlaybackProject): TimeUs {
  const composition = findIrComposition(project.program);
  const clipDuration = composition.timeline.tracks.reduce(
    (maximum, track) =>
      track.clips.reduce(
        (trackMaximum, clip) => Math.max(trackMaximum, clip.timelineStartUs + clip.durationUs),
        maximum,
      ),
    0,
  );
  return timeUs(
    composition.timeline.captionTracks.reduce(
      (maximum, track) =>
        track.cues.reduce(
          (cueMaximum, cue) => Math.max(cueMaximum, cue.startUs + cue.durationUs),
          maximum,
        ),
      clipDuration,
    ),
  );
}

export function resolveSceneFrame(project: PlaybackProject, timelineTimeUs: TimeUs): ResolvedScene {
  const composition = findIrComposition(project.program);
  const plan = createRenderPlan(project.program, timelineTimeUs);
  const assets = new Map(project.assets.map((asset) => [asset.id as string, asset]));
  const clips = clipsById(composition);
  const media: ResolvedLayer[] = [];
  const graphics: ResolvedGraphicLayer[] = [];
  const text: ResolvedTextLayer[] = [];
  const drawOrder = { value: 0 };

  for (const layer of plan.layers) {
    const resolved = clips.get(layer.clipId);
    if (!resolved) continue;
    appendTransitionDip(layer, composition, graphics, drawOrder);
    appendPlanMediaLayer(layer, resolved, composition, assets, media, drawOrder);
    appendPlanContentLayer(layer, resolved, composition, assets, media, graphics, text, drawOrder);
  }
  appendPlanCaptions(plan.captions, composition, graphics, text, drawOrder);
  return { media, graphics, text, background: parseColor(plan.background) };
}

type PlannedLayer = ReturnType<typeof createRenderPlan>["layers"][number];
type PlannedCaption = ReturnType<typeof createRenderPlan>["captions"][number];
type ResolvedClip = { clip: IrClip; track: IrTrack };

function captionWordRange(caption: PlannedCaption, index: number) {
  let cursor = 0;
  for (const [wordIndex, word] of caption.cue.words.entries()) {
    const start = caption.cue.text.indexOf(word.text, cursor);
    if (start < 0) return undefined;
    const end = start + word.text.length;
    if (wordIndex === index) return { start, end };
    cursor = end;
  }
  return undefined;
}

function captionEmphasis(caption: PlannedCaption, props: Record<string, IrValue>) {
  const index = Math.round(numeric(props.wordProgress, -1));
  const range = captionWordRange(caption, index);
  if (!range) return undefined;
  return {
    ...range,
    color: parseColor(stringValue(props.emphasisFill, "#ffd54a")),
    scale: Math.max(1, numeric(props.emphasisScale, 1.08)),
  };
}

function captionOriginY(
  placement: string,
  compositionHeight: number,
  safeMargin: number,
  estimatedHeight: number,
): number {
  if (placement === "top") return safeMargin;
  if (placement === "center") return (compositionHeight - estimatedHeight) / 2;
  return compositionHeight - safeMargin - estimatedHeight;
}

function captionBackground(
  id: string,
  color: readonly [number, number, number, number],
  box: Box,
  composition: IrComposition,
  order: number,
): ResolvedGraphicLayer | null {
  if (color[3] <= 0) return null;
  return {
    nodeId: `${id}/background`,
    kind: "solid",
    transform: {
      x: ((box.x + box.width / 2) / composition.width) * 2 - 1,
      y: ((box.y + box.height / 2) / composition.height) * 2 - 1,
      scaleX: box.width / composition.width,
      scaleY: box.height / composition.height,
      rotation: 0,
      opacity: 1,
      fit: "fill",
    },
    color,
    cornerRadiusPx: 12,
    blurPx: 0,
    order,
  };
}

function resolvedCaption(
  caption: PlannedCaption,
  composition: IrComposition,
  order: number,
): { text: ResolvedTextLayer; background: ResolvedGraphicLayer | null } {
  const props = { ...caption.track.props, ...caption.props };
  const safeX = (numeric(props.safeMarginX, 8) / 100) * composition.width;
  const safeY = (numeric(props.safeMarginY, 8) / 100) * composition.height;
  const fontSize = Math.max(8, numeric(props.fontSize, 64));
  const lineHeight = Math.max(0.5, numeric(props.lineHeight, 1.15));
  const estimatedHeight = fontSize * lineHeight * 2;
  const emphasis = captionEmphasis(caption, props);
  const box = {
    x: safeX + numeric(props.x, 0),
    y:
      captionOriginY(
        stringValue(props.placement, "bottom"),
        composition.height,
        safeY,
        estimatedHeight,
      ) + numeric(props.y, 0),
    width: Math.max(1, composition.width - safeX * 2),
    height: estimatedHeight,
  };
  return {
    text: {
      nodeId: caption.cue.id,
      text: caption.cue.text,
      originX: box.x,
      originY: box.y,
      maxWidth: box.width,
      fontSize,
      fontWeight: numeric(props.fontWeight, 600),
      lineHeight,
      letterSpacing: numeric(props.letterSpacing, 0),
      align: stringValue(props.align, "center") as ResolvedTextLayer["align"],
      color: parseColor(stringValue(props.fill, "#ffffff")),
      outlineColor: parseColor(stringValue(props.outlineColor, "#000000")),
      outlineWidth: Math.max(0, numeric(props.outlineWidth, 3)),
      shadowColor: parseColor(stringValue(props.shadowColor, "#00000099")),
      shadowBlur: Math.max(0, numeric(props.shadowBlur, 8)),
      shadowX: numeric(props.shadowX, 0),
      shadowY: numeric(props.shadowY, 4),
      opacity: Math.min(1, Math.max(0, numeric(props.opacity, 1))),
      scale: numeric(props.scale, 1),
      rotation: numeric(props.rotation, 0),
      ...(emphasis ? { emphasis } : {}),
      order: order + 1,
    },
    background: captionBackground(
      caption.cue.id,
      parseColor(stringValue(props.background, "#00000000")),
      box,
      composition,
      order,
    ),
  };
}

function appendPlanCaptions(
  captions: readonly PlannedCaption[],
  composition: IrComposition,
  graphics: ResolvedGraphicLayer[],
  text: ResolvedTextLayer[],
  drawOrder: { value: number },
): void {
  for (const caption of captions) {
    const resolved = resolvedCaption(caption, composition, drawOrder.value);
    if (resolved.background) graphics.push(resolved.background);
    text.push(resolved.text);
    drawOrder.value += 2;
  }
}

function clipsById(composition: IrComposition): Map<string, ResolvedClip> {
  const clips = new Map<string, ResolvedClip>();
  for (const track of composition.timeline.tracks)
    for (const clip of track.clips) clips.set(clip.id, { clip, track });
  return clips;
}

function appendPlanMediaLayer(
  layer: PlannedLayer,
  { clip, track }: ResolvedClip,
  composition: IrComposition,
  assets: Map<string, Asset>,
  media: ResolvedLayer[],
  drawOrder: { value: number },
): void {
  if (layer.assetId === undefined) return;
  const asset = assets.get(layer.assetId);
  if (!asset || asset.kind === "audio") return;
  const transition = resolvedLayerTransition(layer);
  media.push({
    asset,
    clip,
    track,
    nodeId: clip.id,
    sourceTimeUs: timeUs(layer.sourceTimeUs),
    opacity: layer.opacity,
    transform: directTransform(clip.transform, layer.opacity, composition),
    cornerRadiusPx: clip.transform.cornerRadius,
    colorAdjustment: colorAdjustment(layer.effects),
    visualEffects: visualEffects(layer.effects),
    ...(transition ? { transition } : {}),
    order: drawOrder.value++,
  });
}

function resolvedLayerTransition(layer: PlannedLayer): ResolvedLayer["transition"] {
  const transition = layer.transition;
  if (!transition || (transition.role !== "to" && transition.kind === "wipe")) return undefined;
  if (transition.kind !== "wipe" && transition.kind !== "blur") return undefined;
  const direction = stringValue(transition.props.direction, "left") as NonNullable<
    ResolvedLayer["transition"]
  >["direction"];
  return {
    kind: transition.kind,
    progress: transition.progress,
    direction,
    softness: Math.max(0, numeric(transition.props.softness, 2) / 100),
    intensity:
      Math.max(0, numeric(transition.props.intensity, 1)) *
      (transition.role === "from" ? transition.progress : 1 - transition.progress),
  };
}

function appendTransitionDip(
  layer: PlannedLayer,
  composition: IrComposition,
  graphics: ResolvedGraphicLayer[],
  drawOrder: { value: number },
): void {
  const transition = layer.transition;
  if (transition?.kind !== "dip" || transition.role !== "to") return;
  graphics.push({
    nodeId: `${transition.id}/dip`,
    kind: "solid",
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      opacity: 1,
      fit: "fill",
    },
    color: parseColor(stringValue(transition.props.color, composition.background)),
    cornerRadiusPx: 0,
    blurPx: 0,
    order: drawOrder.value++,
  });
}

function appendPlanContentLayer(
  layer: PlannedLayer,
  { clip, track }: ResolvedClip,
  composition: IrComposition,
  assets: Map<string, Asset>,
  media: ResolvedLayer[],
  graphics: ResolvedGraphicLayer[],
  text: ResolvedTextLayer[],
  drawOrder: { value: number },
): void {
  if (layer.content === undefined) return;
  resolveContent(
    layer.content,
    {
      originX: 0,
      originY: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: layer.opacity,
      available: { x: 0, y: 0, width: composition.width, height: composition.height },
      effects: layer.effects,
    },
    undefined,
    {
      composition,
      clip,
      track,
      sourceTimeUs: timeUs(layer.sourceTimeUs),
      assets,
      media,
      graphics,
      text,
      drawOrder,
    },
  );
}

/** Compatibility projection for callers interested only in decoded media. */
export function resolveScene(project: PlaybackProject, timelineTimeUs: TimeUs): ResolvedLayer[] {
  return resolveSceneFrame(project, timelineTimeUs).media;
}

function contentAssetIds(node: EvaluatedIrNode | IrClip["content"]): string[] {
  if (!node) return [];
  const ids = Object.values(node.props).flatMap((value) =>
    value.kind === "resource" ? [value.assetId] : [],
  );
  return [...ids, ...node.children.flatMap((child) => contentAssetIds(child))];
}

export function findUpcomingLayers(
  project: PlaybackProject,
  timelineTimeUs: TimeUs,
  lookAheadUs: TimeUs = timeUs(1_000_000),
): ResolvedLayer[] {
  const composition = findIrComposition(project.program);
  const assets = new Map(project.assets.map((asset) => [asset.id as string, asset]));
  const endUs = timelineTimeUs + lookAheadUs;
  return composition.timeline.tracks.toReversed().flatMap((track) =>
    track.kind === "audio" || track.muted
      ? []
      : track.clips.flatMap((clip) => {
          if (
            !clip.enabled ||
            clip.timelineStartUs <= timelineTimeUs ||
            clip.timelineStartUs > endUs
          )
            return [];
          const assetIds = [
            ...(clip.assetId === undefined ? [] : [clip.assetId]),
            ...contentAssetIds(clip.content),
          ];
          return [...new Set(assetIds)].flatMap((assetId) => {
            const asset = assets.get(assetId);
            return asset && asset.kind !== "audio"
              ? [
                  {
                    asset,
                    clip,
                    track,
                    nodeId: clip.id,
                    sourceTimeUs: timeUs(clip.sourceStartUs),
                    opacity: clipOpacity(clip, clip.timelineStartUs),
                    transform: directTransform(
                      clip.transform,
                      clipOpacity(clip, clip.timelineStartUs),
                      composition,
                    ),
                    cornerRadiusPx: clip.transform.cornerRadius,
                    colorAdjustment: colorAdjustment([...track.effects, ...clip.effects]),
                    visualEffects: visualEffects([...track.effects, ...clip.effects]),
                    order: 0,
                  },
                ]
              : [];
          });
        }),
  );
}
