declare const IR_TIME_US: unique symbol;

/** Runtime/canonical time. Construction is validated by {@link irTimeUs}. */
export type IrTimeUs = number & { readonly [IR_TIME_US]: "IrTimeUs" };

export function irTimeUs(value: number): IrTimeUs {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("IR time must be a non-negative safe integer number of microseconds.");
  }
  return value as IrTimeUs;
}

export interface SourcePoint {
  line: number;
  column: number;
  offset: number;
}

export interface SourceSpan {
  uri: string;
  revision: string;
  start: SourcePoint;
  end: SourcePoint;
}

export interface ComponentFrame {
  name: string;
  definition: SourceSpan;
  invocation: SourceSpan;
  instanceId: string;
}

export type IrValue =
  | { kind: "angle"; unit: "deg"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "color"; value: string }
  | { kind: "decibels"; value: number }
  | { kind: "length"; unit: "px"; value: number }
  | { kind: "number"; value: number }
  | { kind: "percent"; value: number }
  | { kind: "rectangle"; values: [number, number, number, number] }
  | { kind: "resource"; assetId: string }
  | { kind: "string"; value: string }
  | { kind: "time"; valueUs: IrTimeUs }
  | { kind: "vector"; values: [number, number] };

export type IrValueKind = IrValue["kind"];
export type EditScope = "instance" | "definition" | "materialized";
export type BindingKind = "direct" | "instance" | "default" | "computed" | "animated" | "generated";

export type SourcePrintStrategy =
  | "replace-expression"
  | "replace-jsx-string"
  | "insert-jsx-attribute";

export interface IrEditTarget {
  expected: IrValueKind;
  source: SourceSpan;
  strategy: SourcePrintStrategy;
}

export interface IrKeyframe {
  at: IrTimeUs;
  value: IrValue;
  easing: string;
}

export interface IrAnimation {
  property: string;
  keyframes: IrKeyframe[];
}

export interface IrEffect {
  id: string;
  kind:
    | "colorgrade"
    | "blur"
    | "shadow"
    | "lut"
    | "chromakey"
    | "vignette"
    | "grain"
    | "eq"
    | "compressor"
    | "ducker";
  enabled: boolean;
  props: Record<string, IrValue>;
  animations?: IrAnimation[];
  children: IrSceneNode[];
}

export interface IrAdjustmentLayer {
  id: string;
  trackId: string;
  timelineStartUs: IrTimeUs;
  durationUs: IrTimeUs;
  scope: "below" | "tracks";
  depth: number;
  targetTrackIds: string[];
  enabled: boolean;
  animations: IrAnimation[];
  effects: IrEffect[];
}

export interface IrSceneNode {
  id: string;
  kind: string;
  props: Record<string, IrValue>;
  animations: IrAnimation[];
  effects: IrEffect[];
  children: IrSceneNode[];
}

export type IrTrackKind = "video" | "audio" | "overlay";
export type IrMediaKind = "video" | "audio";

export interface IrTransform {
  x: number;
  y: number;
  width?: number;
  height?: number;
  anchorX: number;
  anchorY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  zIndex: number;
  fit: "contain" | "cover" | "fill";
  crop?: [number, number, number, number];
  cornerRadius: number;
  blendMode: string;
}

export interface IrAudioProperties {
  gainDb: number;
  pan: number;
  muted: boolean;
}

export interface IrFades {
  inUs: IrTimeUs;
  outUs: IrTimeUs;
}

export interface IrClip {
  id: string;
  trackId: string;
  name?: string;
  assetId?: string;
  compositionId?: string;
  mediaKind?: IrMediaKind;
  linkedClipId?: string;
  timelineStartUs: IrTimeUs;
  sourceStartUs: IrTimeUs;
  durationUs: IrTimeUs;
  playbackRate: number;
  enabled: boolean;
  reverse: boolean;
  freeze: boolean;
  loop: boolean;
  fades: IrFades;
  transform: IrTransform;
  audio: IrAudioProperties;
  content?: IrSceneNode;
  effects: IrEffect[];
  animations?: IrAnimation[];
}

export interface IrTrack {
  id: string;
  kind: IrTrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: IrClip[];
  adjustments?: IrAdjustmentLayer[];
  effects: IrEffect[];
}

export interface IrMarker {
  id: string;
  atUs: IrTimeUs;
  name: string;
  color?: string;
}

export interface IrTimelineNote {
  id: string;
  atUs: IrTimeUs;
  durationUs?: IrTimeUs;
  kind: "story-intent" | "scene" | "continuity" | "edit-task" | "review-feedback" | "general";
  text: string;
}

export interface IrCaptionWord {
  id: string;
  startUs: IrTimeUs;
  durationUs: IrTimeUs;
  text: string;
}

export interface IrCaptionCue {
  id: string;
  startUs: IrTimeUs;
  durationUs: IrTimeUs;
  text: string;
  speaker?: string;
  props: Record<string, IrValue>;
  animations: IrAnimation[];
  words: IrCaptionWord[];
}

export interface IrCaptionTrack {
  id: string;
  name: string;
  transcriptFingerprint?: string;
  language?: string;
  props: Record<string, IrValue>;
  cues: IrCaptionCue[];
}

export interface IrTransition {
  id: string;
  fromClipId: string;
  toClipId: string;
  kind: "cut" | "dissolve" | "dip" | "wipe" | "slide" | "push" | "zoom" | "blur";
  durationUs: IrTimeUs;
  easing: string;
  props: Record<string, IrValue>;
}

export interface IrAudioTransition {
  id: string;
  fromClipId: string;
  toClipId: string;
  durationUs: IrTimeUs;
  easing: string;
  curve: "linear" | "equal-power";
}

export interface IrTimeline {
  id: string;
  tracks: IrTrack[];
  captionTracks: IrCaptionTrack[];
  notes: IrTimelineNote[];
  markers: IrMarker[];
  transitions: IrTransition[];
  audioTransitions: IrAudioTransition[];
}

export interface IrComposition {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  background: string;
  timeline: IrTimeline;
}

export interface IrProgram {
  version: 2;
  languageVersion: 1;
  projectId: string;
  activeCompositionId: string;
  compositions: IrComposition[];
  referencedAssetIds: string[];
}

export interface IrDiagnosticRelatedLocation {
  message: string;
  source: SourceSpan;
}

export interface IrDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  source?: SourceSpan;
  related?: IrDiagnosticRelatedLocation[];
}

export interface SourceTextStyle {
  newline: "\n" | "\r\n";
  indent: string;
}

export interface IrPropertyBinding {
  nodeId: string;
  property: string;
  /** JSX attribute to insert when the semantic property is supplied by a component prop. */
  writeProperty?: string;
  value: IrValue;
  kind: BindingKind;
  readSpan: SourceSpan;
  attributeSpan?: SourceSpan;
  writeSpan?: SourceSpan;
  insertion?: { source: SourceSpan; beforeOffset: number };
  strategy: SourcePrintStrategy;
  scopes: EditScope[];
  componentStack: ComponentFrame[];
}

export interface IrStructuralBinding {
  nodeId: string;
  nodeKind: string;
  kind: BindingKind;
  element: SourceSpan;
  openingElement: SourceSpan;
  children: SourceSpan;
  attributeInsertionOffset: number;
  insertionOffset: number;
  leadingTrivia?: SourceSpan;
  trailingTrivia?: SourceSpan;
  style: SourceTextStyle;
  componentStack: ComponentFrame[];
  safeToRemove: boolean;
  safeToMove: boolean;
}

export interface IrEditMapNode {
  structural: IrStructuralBinding;
  properties: Record<string, IrPropertyBinding>;
  animations: Array<{
    property: string;
    origin: SourceSpan;
    keyframes: Array<{
      origin: SourceSpan;
      at: IrEditTarget;
      value: IrEditTarget;
    }>;
  }>;
}

export interface IrEditMap {
  version: 2;
  entry: string;
  sources: Array<{ uri: string; revision: string }>;
  nodes: Record<string, IrEditMapNode>;
}

/** Compatibility name used by adapters; this is an edit map, not runtime IR. */
export type IrSourceMap = IrEditMap;

export type IrNodeTemplate =
  | { kind: "composition"; composition: IrComposition }
  | { kind: "track"; track: IrTrack }
  | { kind: "captiontrack"; track: IrCaptionTrack }
  | { kind: "clip"; clip: IrClip }
  | { kind: "marker"; marker: IrMarker }
  | { kind: "note"; note: IrTimelineNote }
  | { kind: "transition"; transition: IrTransition }
  | { kind: "scene"; node: IrSceneNode };

export type SemanticPatch =
  | {
      type: "property.set";
      nodeId: string;
      property: string;
      value: IrValue;
      scope: EditScope;
    }
  | { type: "property.remove"; nodeId: string; property: string }
  | {
      type: "keyframe.set";
      nodeId: string;
      property: string;
      index: number;
      atUs?: IrTimeUs;
      value?: IrValue;
    }
  | { type: "node.insert"; parentId: string; node: IrNodeTemplate; anchor?: string }
  | { type: "node.remove"; nodeId: string }
  | { type: "node.move"; nodeId: string; parentId: string; anchor?: string }
  | { type: "node.replace"; nodeId: string; nodes: IrNodeTemplate[] };

export interface TimelineClipProjection {
  id: string;
  trackId: string;
  assetId?: string;
  label: string;
  startUs: IrTimeUs;
  endUs: IrTimeUs;
  sourceStartUs: IrTimeUs;
  sourceEndUs: IrTimeUs;
  mediaKind?: IrMediaKind;
  linkedClipId?: string;
  enabled: boolean;
  fadeInUs: IrTimeUs;
  fadeOutUs: IrTimeUs;
  audio: IrAudioProperties;
  transform: IrTransform;
  editable: boolean;
  generated: boolean;
}

export interface TimelineTrackProjection {
  id: string;
  kind: IrTrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: TimelineClipProjection[];
  adjustments: IrAdjustmentLayer[];
}

export interface TimelineProjection {
  compositionId: string;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  durationUs: IrTimeUs;
  tracks: TimelineTrackProjection[];
  captionTracks: IrCaptionTrack[];
  notes: IrTimelineNote[];
  markers: IrMarker[];
  transitions: IrTransition[];
  audioTransitions: IrAudioTransition[];
}

export interface RenderTransition {
  id: string;
  fromClipId: string;
  toClipId: string;
  kind: IrTransition["kind"];
  startUs: IrTimeUs;
  durationUs: IrTimeUs;
  progress: number;
  props: Record<string, IrValue>;
}

export interface RenderLayer {
  clipId: string;
  trackId: string;
  assetId?: string;
  sourceTimeUs: IrTimeUs;
  opacity: number;
  transform: IrTransform;
  content?: EvaluatedIrNode;
  effects: IrEffect[];
  transition?: {
    id: string;
    kind: IrTransition["kind"];
    role: "from" | "to";
    progress: number;
    props: Record<string, IrValue>;
  };
}

export interface RenderPlan {
  compositionId: string;
  playheadUs: IrTimeUs;
  background: string;
  layers: RenderLayer[];
  transitions: RenderTransition[];
  adjustments: Array<{
    id: string;
    trackId: string;
    targetTrackIds: string[];
    effects: IrEffect[];
  }>;
  captions: Array<{
    track: IrCaptionTrack;
    cue: IrCaptionCue;
    localTimeUs: IrTimeUs;
    props: Record<string, IrValue>;
  }>;
}

export interface AudioSourcePlan {
  clipId: string;
  trackId: string;
  assetId: string;
  sourceTimeUs: IrTimeUs;
  gain: number;
  pan: number;
  effects: IrEffect[];
}

export interface AudioPlan {
  compositionId: string;
  playheadUs: IrTimeUs;
  sources: AudioSourcePlan[];
}

export interface EvaluatedIrNode {
  id: string;
  kind: string;
  props: Record<string, IrValue>;
  effects: IrEffect[];
  children: EvaluatedIrNode[];
}
