import { irTimeUs } from "@cinesim/ir";
import type { IrValue, IrValueKind } from "@cinesim/ir";

export type PropertyGroup =
  | "timing"
  | "transform"
  | "appearance"
  | "text"
  | "audio"
  | "effect"
  | "structure";
export type PropertyControl =
  | "number"
  | "slider"
  | "color"
  | "select"
  | "asset"
  | "text"
  | "toggle";

export interface PropertySchema {
  name: string;
  type: IrValueKind;
  label: string;
  group: PropertyGroup;
  control: PropertyControl;
  required: boolean;
  animatable: boolean;
  defaultValue?: IrValue;
  minimum?: IrValue;
  maximum?: IrValue;
  step?: number;
  options?: string[];
}

export interface BuiltinSchema {
  name: string;
  category: "temporal" | "content" | "layout" | "effect" | "motion";
  properties: Record<string, PropertySchema>;
  allowedChildren?: string[] | "scene";
}

const value = <T extends IrValue>(input: T): T => input;
const property = (
  name: string,
  type: IrValueKind,
  group: PropertyGroup,
  control: PropertyControl,
  options: Partial<Omit<PropertySchema, "name" | "type" | "label" | "group" | "control">> = {},
): PropertySchema => ({
  name,
  type,
  label: name.replaceAll(/([A-Z])/gu, " $1").replace(/^./u, (letter) => letter.toUpperCase()),
  group,
  control,
  required: false,
  animatable: group !== "structure" && group !== "timing",
  ...options,
});

const required = (schema: PropertySchema): PropertySchema => ({ ...schema, required: true });
const id = required(property("id", "string", "structure", "text", { animatable: false }));
const scene = {
  id,
  x: property("x", "length", "transform", "number", {
    defaultValue: value({ kind: "length", unit: "px", value: 0 }),
    step: 1,
  }),
  y: property("y", "length", "transform", "number", {
    defaultValue: value({ kind: "length", unit: "px", value: 0 }),
    step: 1,
  }),
  width: property("width", "length", "transform", "number", { step: 1 }),
  height: property("height", "length", "transform", "number", { step: 1 }),
  anchorX: property("anchorX", "percent", "transform", "slider", {
    defaultValue: value({ kind: "percent", value: 50 }),
  }),
  anchorY: property("anchorY", "percent", "transform", "slider", {
    defaultValue: value({ kind: "percent", value: 50 }),
  }),
  scaleX: property("scaleX", "number", "transform", "number", {
    defaultValue: value({ kind: "number", value: 1 }),
    step: 0.01,
  }),
  scaleY: property("scaleY", "number", "transform", "number", {
    defaultValue: value({ kind: "number", value: 1 }),
    step: 0.01,
  }),
  scale: property("scale", "number", "transform", "number", {
    defaultValue: value({ kind: "number", value: 1 }),
    step: 0.01,
  }),
  rotation: property("rotation", "angle", "transform", "number", {
    defaultValue: value({ kind: "angle", unit: "deg", value: 0 }),
    step: 0.1,
  }),
  opacity: property("opacity", "number", "appearance", "slider", {
    defaultValue: value({ kind: "number", value: 1 }),
    minimum: value({ kind: "number", value: 0 }),
    maximum: value({ kind: "number", value: 1 }),
    step: 0.01,
  }),
  z: property("z", "number", "appearance", "number", {
    defaultValue: value({ kind: "number", value: 0 }),
    step: 1,
  }),
  blendMode: property("blendMode", "string", "appearance", "select", {
    defaultValue: value({ kind: "string", value: "normal" }),
    options: ["normal", "multiply", "screen", "overlay", "darken", "lighten"],
  }),
};

const clipProps: Record<string, PropertySchema> = {
  ...scene,
  name: property("name", "string", "structure", "text", { animatable: false }),
  asset: property("asset", "resource", "structure", "asset", { animatable: false }),
  composition: property("composition", "string", "structure", "select", { animatable: false }),
  media: property("media", "string", "structure", "select", {
    animatable: false,
    options: ["video", "audio"],
  }),
  linked: property("linked", "string", "structure", "text", { animatable: false }),
  start: required(
    property("start", "time", "timing", "number", {
      animatable: false,
      defaultValue: value({ kind: "time", valueUs: irTimeUs(0) }),
    }),
  ),
  in: property("in", "time", "timing", "number", {
    animatable: false,
    defaultValue: value({ kind: "time", valueUs: irTimeUs(0) }),
  }),
  duration: required(property("duration", "time", "timing", "number", { animatable: false })),
  playbackRate: property("playbackRate", "number", "timing", "number", {
    animatable: false,
    defaultValue: value({ kind: "number", value: 1 }),
  }),
  enabled: property("enabled", "boolean", "timing", "toggle", {
    animatable: false,
    defaultValue: value({ kind: "boolean", value: true }),
  }),
  reverse: property("reverse", "boolean", "timing", "toggle", {
    animatable: false,
    defaultValue: value({ kind: "boolean", value: false }),
  }),
  freeze: property("freeze", "boolean", "timing", "toggle", {
    animatable: false,
    defaultValue: value({ kind: "boolean", value: false }),
  }),
  loop: property("loop", "boolean", "timing", "toggle", {
    animatable: false,
    defaultValue: value({ kind: "boolean", value: false }),
  }),
  fadeIn: property("fadeIn", "time", "timing", "number", {
    animatable: false,
    defaultValue: value({ kind: "time", valueUs: irTimeUs(0) }),
  }),
  fadeOut: property("fadeOut", "time", "timing", "number", {
    animatable: false,
    defaultValue: value({ kind: "time", valueUs: irTimeUs(0) }),
  }),
  gain: property("gain", "decibels", "audio", "number", {
    defaultValue: value({ kind: "decibels", value: 0 }),
    step: 0.1,
  }),
  pan: property("pan", "number", "audio", "slider", {
    defaultValue: value({ kind: "number", value: 0 }),
    minimum: value({ kind: "number", value: -1 }),
    maximum: value({ kind: "number", value: 1 }),
    step: 0.01,
  }),
  muted: property("muted", "boolean", "audio", "toggle", {
    defaultValue: value({ kind: "boolean", value: false }),
  }),
  fit: property("fit", "string", "appearance", "select", {
    defaultValue: value({ kind: "string", value: "contain" }),
    options: ["contain", "cover", "fill"],
  }),
  cornerRadius: property("cornerRadius", "length", "appearance", "number", {
    defaultValue: value({ kind: "length", unit: "px", value: 0 }),
  }),
  crop: property("crop", "rectangle", "appearance", "number"),
};

const effect = (
  name: BuiltinSchema["name"],
  properties: Record<string, PropertySchema>,
): BuiltinSchema => ({
  name,
  category: "effect",
  properties: {
    id,
    enabled: property("enabled", "boolean", "effect", "toggle", {
      defaultValue: value({ kind: "boolean", value: true }),
    }),
    ...properties,
  },
  allowedChildren: "scene",
});

export const BUILTIN_REGISTRY: Readonly<Record<string, BuiltinSchema>> = {
  composition: {
    name: "composition",
    category: "temporal",
    properties: {
      id,
      name: property("name", "string", "structure", "text", { animatable: false }),
      width: required(property("width", "number", "structure", "number", { animatable: false })),
      height: required(property("height", "number", "structure", "number", { animatable: false })),
      fps: required(property("fps", "number", "structure", "number", { animatable: false })),
      frameRate: property("frameRate", "number", "structure", "number", { animatable: false }),
      background: property("background", "color", "appearance", "color", {
        defaultValue: value({ kind: "color", value: "#09090b" }),
      }),
    },
    allowedChildren: ["timeline"],
  },
  timeline: {
    name: "timeline",
    category: "temporal",
    properties: { id },
    allowedChildren: ["track", "captiontrack", "note", "marker", "transition"],
  },
  track: {
    name: "track",
    category: "temporal",
    properties: {
      id,
      kind: required(
        property("kind", "string", "structure", "select", {
          animatable: false,
          options: ["video", "audio", "overlay"],
        }),
      ),
      name: required(property("name", "string", "structure", "text", { animatable: false })),
      muted: property("muted", "boolean", "audio", "toggle", {
        defaultValue: value({ kind: "boolean", value: false }),
      }),
      locked: property("locked", "boolean", "structure", "toggle", {
        animatable: false,
        defaultValue: value({ kind: "boolean", value: false }),
      }),
    },
    allowedChildren: [
      "clip",
      "colorgrade",
      "blur",
      "shadow",
      "lut",
      "chromakey",
      "vignette",
      "grain",
      "ducker",
    ],
  },
  captiontrack: {
    name: "captiontrack",
    category: "temporal",
    properties: {
      id,
      name: required(property("name", "string", "structure", "text", { animatable: false })),
      transcriptFingerprint: property("transcriptFingerprint", "string", "structure", "text", {
        animatable: false,
      }),
      language: property("language", "string", "structure", "text", { animatable: false }),
      fontFamily: property("fontFamily", "string", "text", "text", {
        defaultValue: value({ kind: "string", value: "Instrument Sans" }),
      }),
      fontSize: property("fontSize", "length", "text", "number", {
        defaultValue: value({ kind: "length", unit: "px", value: 64 }),
      }),
      fontWeight: property("fontWeight", "number", "text", "number", {
        defaultValue: value({ kind: "number", value: 600 }),
      }),
      lineHeight: property("lineHeight", "number", "text", "number", {
        defaultValue: value({ kind: "number", value: 1.15 }),
      }),
      placement: property("placement", "string", "text", "select", {
        defaultValue: value({ kind: "string", value: "bottom" }),
        options: ["top", "center", "bottom"],
      }),
      align: property("align", "string", "text", "select", {
        defaultValue: value({ kind: "string", value: "center" }),
        options: ["left", "center", "right"],
      }),
      fill: property("fill", "color", "text", "color", {
        defaultValue: value({ kind: "color", value: "#ffffff" }),
      }),
      outlineColor: property("outlineColor", "color", "text", "color", {
        defaultValue: value({ kind: "color", value: "#000000" }),
      }),
      outlineWidth: property("outlineWidth", "length", "text", "number", {
        defaultValue: value({ kind: "length", unit: "px", value: 3 }),
      }),
      shadowColor: property("shadowColor", "color", "text", "color", {
        defaultValue: value({ kind: "color", value: "#00000099" }),
      }),
      shadowBlur: property("shadowBlur", "length", "text", "number", {
        defaultValue: value({ kind: "length", unit: "px", value: 8 }),
      }),
      shadowX: property("shadowX", "length", "text", "number", {
        defaultValue: value({ kind: "length", unit: "px", value: 0 }),
      }),
      shadowY: property("shadowY", "length", "text", "number", {
        defaultValue: value({ kind: "length", unit: "px", value: 4 }),
      }),
      background: property("background", "color", "text", "color", {
        defaultValue: value({ kind: "color", value: "#00000000" }),
      }),
      safeMarginX: property("safeMarginX", "percent", "text", "slider", {
        defaultValue: value({ kind: "percent", value: 8 }),
      }),
      safeMarginY: property("safeMarginY", "percent", "text", "slider", {
        defaultValue: value({ kind: "percent", value: 8 }),
      }),
      animationPreset: property("animationPreset", "string", "text", "select", {
        defaultValue: value({ kind: "string", value: "none" }),
        options: ["none", "word-emphasis", "pop", "scale", "color", "position"],
      }),
      emphasisFill: property("emphasisFill", "color", "text", "color", {
        defaultValue: value({ kind: "color", value: "#ffd54a" }),
      }),
      emphasisScale: property("emphasisScale", "number", "text", "number", {
        defaultValue: value({ kind: "number", value: 1.08 }),
      }),
    },
    allowedChildren: ["cue"],
  },
  cue: {
    name: "cue",
    category: "temporal",
    properties: {
      ...scene,
      start: required(property("start", "time", "timing", "number", { animatable: false })),
      duration: required(property("duration", "time", "timing", "number", { animatable: false })),
      text: required(property("text", "string", "text", "text", { animatable: false })),
      speaker: property("speaker", "string", "structure", "text", { animatable: false }),
      fontSize: property("fontSize", "length", "text", "number"),
      fontWeight: property("fontWeight", "number", "text", "number"),
      fill: property("fill", "color", "text", "color"),
      outlineColor: property("outlineColor", "color", "text", "color"),
      outlineWidth: property("outlineWidth", "length", "text", "number"),
      background: property("background", "color", "text", "color"),
      animationPreset: property("animationPreset", "string", "text", "select", {
        options: ["none", "word-emphasis", "pop", "scale", "color", "position"],
      }),
      emphasisFill: property("emphasisFill", "color", "text", "color"),
      emphasisScale: property("emphasisScale", "number", "text", "number"),
      wordProgress: property("wordProgress", "number", "text", "number", {
        defaultValue: value({ kind: "number", value: -1 }),
      }),
    },
    allowedChildren: ["captionword", "animate"],
  },
  captionword: {
    name: "captionword",
    category: "temporal",
    properties: {
      id,
      start: required(property("start", "time", "timing", "number", { animatable: false })),
      duration: required(property("duration", "time", "timing", "number", { animatable: false })),
      text: required(property("text", "string", "text", "text", { animatable: false })),
    },
  },
  clip: { name: "clip", category: "temporal", properties: clipProps, allowedChildren: "scene" },
  marker: {
    name: "marker",
    category: "temporal",
    properties: {
      id,
      at: required(property("at", "time", "timing", "number", { animatable: false })),
      name: required(property("name", "string", "structure", "text", { animatable: false })),
      color: property("color", "color", "appearance", "color"),
    },
  },
  note: {
    name: "note",
    category: "temporal",
    properties: {
      id,
      at: required(property("at", "time", "timing", "number", { animatable: false })),
      duration: property("duration", "time", "timing", "number", { animatable: false }),
      kind: required(
        property("kind", "string", "structure", "select", {
          animatable: false,
          options: [
            "story-intent",
            "scene",
            "continuity",
            "edit-task",
            "review-feedback",
            "general",
          ],
        }),
      ),
      text: required(property("text", "string", "structure", "text", { animatable: false })),
    },
  },
  transition: {
    name: "transition",
    category: "temporal",
    properties: {
      id,
      from: required(property("from", "string", "structure", "text", { animatable: false })),
      to: required(property("to", "string", "structure", "text", { animatable: false })),
      kind: required(
        property("kind", "string", "effect", "select", {
          animatable: false,
          options: ["cut", "dissolve", "dip", "wipe", "slide", "push", "zoom", "blur"],
        }),
      ),
      duration: required(property("duration", "time", "timing", "number", { animatable: false })),
    },
  },
  video: {
    name: "video",
    category: "content",
    properties: {
      ...scene,
      source: required(property("source", "resource", "structure", "asset", { animatable: false })),
      fit: property("fit", "string", "appearance", "select", {
        options: ["contain", "cover", "fill"],
      }),
      radius: property("radius", "length", "appearance", "number"),
    },
    allowedChildren: "scene",
  },
  audio: {
    name: "audio",
    category: "content",
    properties: {
      id,
      source: required(property("source", "resource", "structure", "asset", { animatable: false })),
      gain: property("gain", "decibels", "audio", "number"),
      pan: property("pan", "number", "audio", "slider"),
    },
  },
  image: {
    name: "image",
    category: "content",
    properties: {
      ...scene,
      source: required(property("source", "resource", "structure", "asset", { animatable: false })),
      fit: property("fit", "string", "appearance", "select", {
        options: ["contain", "cover", "fill"],
      }),
    },
    allowedChildren: "scene",
  },
  text: {
    name: "text",
    category: "content",
    properties: {
      ...scene,
      text: required(property("text", "string", "text", "text")),
      color: property("color", "color", "text", "color"),
      fontFamily: property("fontFamily", "string", "text", "text"),
      fontSize: property("fontSize", "length", "text", "number"),
      fontWeight: property("fontWeight", "number", "text", "number"),
      lineHeight: property("lineHeight", "number", "text", "number"),
      letterSpacing: property("letterSpacing", "length", "text", "number"),
      align: property("align", "string", "text", "select", {
        options: ["left", "center", "right", "justify"],
      }),
      maxWidth: property("maxWidth", "length", "text", "number"),
      fill: property("fill", "color", "text", "color"),
      stroke: property("stroke", "color", "text", "color"),
    },
    allowedChildren: ["span", "shadow"],
  },
  span: {
    name: "span",
    category: "content",
    properties: {
      id,
      text: required(property("text", "string", "text", "text")),
      color: property("color", "color", "text", "color"),
      fontWeight: property("fontWeight", "number", "text", "number"),
    },
  },
  group: { name: "group", category: "layout", properties: scene, allowedChildren: "scene" },
  grid: {
    name: "grid",
    category: "layout",
    properties: {
      ...scene,
      columns: required(
        property("columns", "number", "structure", "number", { animatable: false }),
      ),
      rows: property("rows", "number", "structure", "number", { animatable: false }),
      gap: property("gap", "length", "transform", "number"),
    },
    allowedChildren: "scene",
  },
  stack: {
    name: "stack",
    category: "layout",
    properties: {
      ...scene,
      direction: property("direction", "string", "structure", "select", {
        animatable: false,
        options: ["horizontal", "vertical"],
      }),
      gap: property("gap", "length", "transform", "number"),
      align: property("align", "string", "transform", "select"),
    },
    allowedChildren: "scene",
  },
  mask: { name: "mask", category: "layout", properties: scene, allowedChildren: "scene" },
  rect: {
    name: "rect",
    category: "content",
    properties: {
      ...scene,
      fill: property("fill", "color", "appearance", "color"),
      radius: property("radius", "length", "appearance", "number"),
      blur: property("blur", "length", "appearance", "number"),
    },
    allowedChildren: "scene",
  },
  ellipse: {
    name: "ellipse",
    category: "content",
    properties: { ...scene, fill: property("fill", "color", "appearance", "color") },
    allowedChildren: "scene",
  },
  path: {
    name: "path",
    category: "content",
    properties: {
      ...scene,
      data: required(property("data", "string", "appearance", "text")),
      fill: property("fill", "color", "appearance", "color"),
      stroke: property("stroke", "color", "appearance", "color"),
    },
  },
  colorgrade: effect("colorgrade", {
    exposure: property("exposure", "number", "effect", "slider"),
    contrast: property("contrast", "number", "effect", "slider"),
    saturation: property("saturation", "number", "effect", "slider"),
    temperature: property("temperature", "number", "effect", "slider"),
    tint: property("tint", "number", "effect", "slider"),
    highlights: property("highlights", "number", "effect", "slider"),
    shadows: property("shadows", "number", "effect", "slider"),
  }),
  blur: effect("blur", { radius: property("radius", "length", "effect", "number") }),
  shadow: effect("shadow", {
    x: property("x", "length", "effect", "number"),
    y: property("y", "length", "effect", "number"),
    blur: property("blur", "length", "effect", "number"),
    color: property("color", "color", "effect", "color"),
  }),
  lut: effect("lut", {
    source: required(property("source", "resource", "effect", "asset", { animatable: false })),
    amount: property("amount", "number", "effect", "slider"),
  }),
  chromakey: effect("chromakey", {
    color: property("color", "color", "effect", "color"),
    tolerance: property("tolerance", "number", "effect", "slider"),
  }),
  vignette: effect("vignette", {
    amount: property("amount", "number", "effect", "slider"),
    softness: property("softness", "number", "effect", "slider"),
  }),
  grain: effect("grain", {
    amount: property("amount", "number", "effect", "slider"),
    size: property("size", "number", "effect", "number"),
  }),
  ducker: effect("ducker", {
    sidechain: required(property("sidechain", "string", "audio", "text", { animatable: false })),
    reduction: property("reduction", "decibels", "audio", "number", {
      defaultValue: value({ kind: "decibels", value: -12 }),
      minimum: value({ kind: "decibels", value: -60 }),
      maximum: value({ kind: "decibels", value: 0 }),
      step: 0.1,
    }),
    attack: property("attack", "time", "audio", "number", {
      animatable: false,
      defaultValue: value({ kind: "time", valueUs: irTimeUs(80_000) }),
    }),
    release: property("release", "time", "audio", "number", {
      animatable: false,
      defaultValue: value({ kind: "time", valueUs: irTimeUs(250_000) }),
    }),
  }),
};

export const TEMPORAL_BUILTINS = new Set([
  "composition",
  "timeline",
  "track",
  "captiontrack",
  "cue",
  "captionword",
  "clip",
  "note",
  "marker",
  "transition",
]);
export const EFFECT_BUILTINS = new Set([
  "colorgrade",
  "blur",
  "shadow",
  "lut",
  "chromakey",
  "vignette",
  "grain",
  "ducker",
]);

export function getBuiltinSchema(kind: string): BuiltinSchema | undefined {
  return BUILTIN_REGISTRY[kind];
}
