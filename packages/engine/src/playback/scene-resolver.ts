import { timeUs } from "@cinesim/core";
import type { Asset, TimeUs, Transform } from "@cinesim/core";
import { createRenderPlan, findIrComposition } from "@cinesim/ir";
import type {
  EvaluatedIrNode,
  IrClip,
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
  order: number;
}

export interface ResolvedGraphicLayer {
  nodeId: string;
  kind: "solid" | "glyph";
  transform: Transform;
  color: readonly [number, number, number, number];
  cornerRadiusPx: number;
  blurPx: number;
  glyph?: readonly [number, number];
  order: number;
}

export interface ResolvedScene {
  media: ResolvedLayer[];
  graphics: ResolvedGraphicLayer[];
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
};

const GLYPH_ROWS: Readonly<Record<string, readonly string[]>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
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

function glyphBits(character: string): readonly [number, number] {
  const rows = GLYPH_ROWS[character.toUpperCase()] ?? GLYPH_ROWS["?"]!;
  let low = 0;
  let high = 0;
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      if (rows[row]![column] !== "1") continue;
      const bit = row * 5 + column;
      if (bit < 32) low = (low | (1 << bit)) >>> 0;
      else high = (high | (1 << (bit - 32))) >>> 0;
    }
  }
  return [low, high];
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
    x: ((box.x + box.width / 2) / width) * 2 - 1 + outer.x,
    y: ((box.y + box.height / 2) / height) * 2 - 1 + outer.y,
    scaleX: (box.width / width) * outer.scaleX,
    scaleY: (box.height / height) * outer.scaleY,
    opacity,
    fit,
  };
}

function directTransform(transform: IrTransform, opacity: number): Transform {
  return {
    x: transform.x,
    y: transform.y,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
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
  }
  return adjustment;
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
  const fontSize = Math.max(1, numeric(node.props.fontSize, 32) * layout.scaleY);
  const glyphWidth = fontSize * (5 / 7);
  const advance = glyphWidth + numeric(node.props.letterSpacing, fontSize / 7) * layout.scaleX;
  const color = parseColor(stringValue(node.props.color, stringValue(node.props.fill, "#ffffff")));
  for (const [index, character] of stringValue(node.props.text, "").split("").entries()) {
    if (character === " ") continue;
    output.graphics.push({
      nodeId: `${node.id}/glyph-${index}`,
      kind: "glyph",
      transform: normalizedTransform(
        { x: box.x + index * advance, y: box.y, width: glyphWidth, height: fontSize },
        output.composition.width,
        output.composition.height,
        "fill",
        layout.opacity,
        output.clip.transform,
      ),
      color,
      cornerRadiusPx: 0,
      blurPx: 0,
      glyph: glyphBits(character),
      order: output.drawOrder.value++,
    });
  }
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
  return timeUs(
    composition.timeline.tracks.reduce(
      (maximum, track) =>
        track.clips.reduce(
          (trackMaximum, clip) => Math.max(trackMaximum, clip.timelineStartUs + clip.durationUs),
          maximum,
        ),
      0,
    ),
  );
}

export function resolveSceneFrame(project: PlaybackProject, timelineTimeUs: TimeUs): ResolvedScene {
  const composition = findIrComposition(project.program);
  const plan = createRenderPlan(project.program, timelineTimeUs);
  const assets = new Map(project.assets.map((asset) => [asset.id as string, asset]));
  const clips = new Map<string, { clip: IrClip; track: IrTrack }>();
  for (const track of composition.timeline.tracks)
    for (const clip of track.clips) clips.set(clip.id, { clip, track });
  const media: ResolvedLayer[] = [];
  const graphics: ResolvedGraphicLayer[] = [];
  const drawOrder = { value: 0 };

  for (const layer of plan.layers) {
    const resolved = clips.get(layer.clipId);
    if (!resolved) continue;
    const { clip, track } = resolved;
    if (layer.assetId !== undefined) {
      const asset = assets.get(layer.assetId);
      if (asset && asset.kind !== "audio") {
        media.push({
          asset,
          clip,
          track,
          nodeId: clip.id,
          sourceTimeUs: timeUs(layer.sourceTimeUs),
          opacity: layer.opacity,
          transform: directTransform(clip.transform, layer.opacity),
          cornerRadiusPx: clip.transform.cornerRadius,
          colorAdjustment: colorAdjustment(layer.effects),
          order: drawOrder.value++,
        });
      }
    }
    if (layer.content !== undefined) {
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
          drawOrder,
        },
      );
    }
  }
  return { media, graphics, background: parseColor(plan.background) };
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
                    ),
                    cornerRadiusPx: clip.transform.cornerRadius,
                    colorAdjustment: colorAdjustment([...track.effects, ...clip.effects]),
                    order: 0,
                  },
                ]
              : [];
          });
        }),
  );
}
