import type { Transform } from "@cinesim/core";
import type {
  ColorAdjustment,
  InputColorTransform,
  VisualEffectSettings,
} from "../playback/scene-resolver";
import type { AtlasGlyph, ShapedAtlasGlyph, WebGpuGlyphAtlas } from "./glyph-atlas";
import {
  buildRenderGraph,
  type RenderGraphAdjustment,
  type RenderGraphLayer,
} from "./render-graph";
import { BoundedRenderTexturePool } from "./texture-pool";

const WORKING_TEXTURE_FORMAT: GPUTextureFormat = "rgba16float";

const VIDEO_SHADER = /* wgsl */ `
struct LayerUniforms {
  offsetAndScale: vec4f,
  opacityAndRadius: vec4f,
  uvScaleAndOffset: vec4f,
  colorAdjustOne: vec4f,
  colorAdjustTwo: vec4f,
  transitionOne: vec4f,
  transitionTwo: vec4f,
  effectOne: vec4f,
  effectTwo: vec4f,
  chromaColor: vec4f,
  shadowColor: vec4f,
  shadowParams: vec4f,
}

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> layer: LayerUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );
  let angle = layer.opacityAndRadius.z;
  let scaled = positions[index] * layer.offsetAndScale.zw;
  let rotated = vec2f(
    scaled.x * cos(angle) - scaled.y * sin(angle),
    scaled.x * sin(angle) + scaled.y * cos(angle)
  );
  var output: VertexOutput;
  output.position = vec4f(
    rotated + layer.offsetAndScale.xy,
    0.0,
    1.0
  );
  output.uv = uvs[index];
  return output;
}

fn roundedAlpha(uv: vec2f, radius: f32) -> f32 {
  if (radius <= 0.0) { return 1.0; }
  let point = abs(uv - vec2f(0.5)) - vec2f(0.5 - radius);
  let distance = length(max(point, vec2f(0.0))) - radius;
  return 1.0 - smoothstep(-0.002, 0.002, distance);
}

fn transitionCoordinate(uv: vec2f, direction: f32) -> f32 {
  if (direction < 0.5) { return uv.x; }
  if (direction < 1.5) { return 1.0 - uv.x; }
  if (direction < 2.5) { return uv.y; }
  return 1.0 - uv.y;
}

fn transitionAlpha(uv: vec2f) -> f32 {
  if (layer.transitionOne.x < 0.5) { return 1.0; }
  if (layer.transitionOne.x < 1.5) {
    let coordinate = transitionCoordinate(uv, layer.transitionOne.z);
    let softness = max(0.0001, layer.transitionOne.w);
    return 1.0 - smoothstep(
      layer.transitionOne.y - softness,
      layer.transitionOne.y + softness,
      coordinate
    );
  }
  return 1.0;
}

fn transitionSample(uv: vec2f) -> vec4f {
  if (layer.transitionOne.x < 1.5) {
    return textureSampleBaseClampToEdge(videoTexture, videoSampler, uv);
  }
  let radius = layer.transitionTwo.x * 0.004;
  var result = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv) * 0.4;
  result += textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2f(radius, 0.0)) * 0.15;
  result += textureSampleBaseClampToEdge(videoTexture, videoSampler, uv - vec2f(radius, 0.0)) * 0.15;
  result += textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2f(0.0, radius)) * 0.15;
  result += textureSampleBaseClampToEdge(videoTexture, videoSampler, uv - vec2f(0.0, radius)) * 0.15;
  return result;
}

fn effectSample(uv: vec2f) -> vec4f {
  let radius = layer.effectOne.x;
  if (radius <= 0.00001) { return transitionSample(uv); }
  var result = transitionSample(uv) * 0.4;
  result += transitionSample(uv + vec2f(radius, 0.0)) * 0.15;
  result += transitionSample(uv - vec2f(radius, 0.0)) * 0.15;
  result += transitionSample(uv + vec2f(0.0, radius)) * 0.15;
  result += transitionSample(uv - vec2f(0.0, radius)) * 0.15;
  return result;
}

fn randomGrain(uv: vec2f, size: f32) -> f32 {
  let cell = floor(uv * 2048.0 / max(0.1, size));
  return fract(sin(dot(cell, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
}

fn chromaAlpha(rgb: vec3f, alpha: f32) -> f32 {
  let tolerance = layer.effectTwo.y;
  if (tolerance <= 0.0) { return alpha; }
  let distance = length(rgb - rec709ToLinear(layer.chromaColor.rgb)) / 1.7320508;
  return alpha * smoothstep(tolerance * 0.6, max(tolerance, 0.0001), distance);
}

fn shadowSample(uv: vec2f) -> f32 {
  let blur = layer.shadowParams.z;
  let shifted = uv - layer.shadowParams.xy;
  var alpha = transitionSample(shifted).a * 0.4;
  alpha += transitionSample(shifted + vec2f(blur, 0.0)).a * 0.15;
  alpha += transitionSample(shifted - vec2f(blur, 0.0)).a * 0.15;
  alpha += transitionSample(shifted + vec2f(0.0, blur)).a * 0.15;
  alpha += transitionSample(shifted - vec2f(0.0, blur)).a * 0.15;
  return alpha * layer.shadowColor.a;
}

fn rec709ToLinearChannel(value: f32) -> f32 {
  let bounded = max(0.0, value);
  if (bounded < 0.081) { return bounded / 4.5; }
  return pow((bounded + 0.099) / 1.099, 1.0 / 0.45);
}

fn rec709ToLinear(rgb: vec3f) -> vec3f {
  return vec3f(
    rec709ToLinearChannel(rgb.r),
    rec709ToLinearChannel(rgb.g),
    rec709ToLinearChannel(rgb.b)
  );
}

fn hlgToLinearChannel(value: f32) -> f32 {
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  if (value <= 0.5) { return value * value / 3.0; }
  return (exp((value - c) / a) + b) / 12.0;
}

fn pqToLinearChannel(value: f32) -> f32 {
  let m1 = 0.1593017578125;
  let m2 = 78.84375;
  let c1 = 0.8359375;
  let c2 = 18.8515625;
  let c3 = 18.6875;
  let raised = pow(max(value, 0.0), 1.0 / m2);
  return pow(max(raised - c1, 0.0) / max(c2 - c3 * raised, 0.00001), 1.0 / m1);
}

fn toneMap(rgb: vec3f, referenceWhite: f32) -> vec3f {
  let scene = rgb / referenceWhite;
  return scene / (vec3f(1.0) + scene);
}

fn rec2020ToRec709(rgb: vec3f) -> vec3f {
  return vec3f(
    1.660491 * rgb.r - 0.587641 * rgb.g - 0.072850 * rgb.b,
    -0.124550 * rgb.r + 1.132900 * rgb.g - 0.008349 * rgb.b,
    -0.018151 * rgb.r - 0.100579 * rgb.g + 1.118730 * rgb.b
  );
}

fn inputPrimariesToWorking(rgb: vec3f) -> vec3f {
  if (layer.effectTwo.w > 0.5) { return rec2020ToRec709(rgb); }
  return rgb;
}

fn inputToWorking(rgb: vec3f) -> vec3f {
  let mode = layer.shadowParams.w;
  if (mode < 0.5) { return rgb; }
  if (mode < 1.5) { return inputPrimariesToWorking(rec709ToLinear(rgb)); }
  if (mode < 2.5) {
    let linear = vec3f(hlgToLinearChannel(rgb.r), hlgToLinearChannel(rgb.g), hlgToLinearChannel(rgb.b));
    let working = inputPrimariesToWorking(linear);
    if (layer.colorAdjustTwo.w > 0.5) { return toneMap(working, 0.2); }
    return working;
  }
  let linear = vec3f(pqToLinearChannel(rgb.r), pqToLinearChannel(rgb.g), pqToLinearChannel(rgb.b));
  let working = inputPrimariesToWorking(linear);
  if (layer.colorAdjustTwo.w > 0.5) { return toneMap(working, 0.01); }
  return working;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv * layer.uvScaleAndOffset.xy + layer.uvScaleAndOffset.zw;
  let sampled = effectSample(uv);
  let exposure = layer.colorAdjustOne.x;
  let contrast = layer.colorAdjustOne.y;
  let saturation = layer.colorAdjustOne.z;
  let temperature = layer.colorAdjustOne.w;
  let tint = layer.colorAdjustTwo.x;
  let highlights = layer.colorAdjustTwo.y;
  let shadows = layer.colorAdjustTwo.z;
  let sourceRgb = inputToWorking(sampled.rgb);
  var rgb = sourceRgb * exp2(exposure);
  rgb = (rgb - vec3f(0.18)) * contrast + vec3f(0.18);
  let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3f(luma), rgb, saturation);
  rgb += vec3f(temperature * 0.08, tint * 0.06, -temperature * 0.08);
  rgb += highlights * smoothstep(0.55, 1.0, luma) + shadows * (1.0 - smoothstep(0.0, 0.45, luma));
  let vignette = 1.0 - layer.effectOne.y * smoothstep(
    max(0.0, 0.72 - layer.effectOne.z),
    0.72,
    distance(input.uv, vec2f(0.5))
  );
  rgb = rgb * vignette + vec3f(randomGrain(input.uv, layer.effectTwo.x) * layer.effectOne.w);
  let shapeAlpha = layer.opacityAndRadius.x * roundedAlpha(input.uv, layer.opacityAndRadius.y) * transitionAlpha(input.uv);
  let alpha = chromaAlpha(sourceRgb, sampled.a) * shapeAlpha;
  let shadowAlpha = shadowSample(uv) * shapeAlpha * (1.0 - alpha);
  return vec4f(mix(rgb, rec709ToLinear(layer.shadowColor.rgb), shadowAlpha), alpha + shadowAlpha);
}
`;

const EFFECT_SHADER = VIDEO_SHADER.replace(
  "@group(0) @binding(0) var videoTexture: texture_external;",
  "@group(0) @binding(0) var videoTexture: texture_2d<f32>;",
).replaceAll("textureSampleBaseClampToEdge", "textureSample");

const GRAPHIC_SHADER = /* wgsl */ `
struct GraphicUniforms {
  offsetAndScale: vec4f,
  color: vec4f,
  params: vec4f,
  transformParams: vec4f,
}

@group(0) @binding(0) var<uniform> graphic: GraphicUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );
  let angle = graphic.transformParams.x;
  let scaled = positions[index] * graphic.offsetAndScale.zw;
  let rotated = vec2f(
    scaled.x * cos(angle) - scaled.y * sin(angle),
    scaled.x * sin(angle) + scaled.y * cos(angle)
  );
  var output: VertexOutput;
  output.position = vec4f(
    rotated + graphic.offsetAndScale.xy,
    0.0,
    1.0
  );
  output.uv = uvs[index];
  return output;
}

fn graphicAlpha(uv: vec2f, radius: f32, feather: f32) -> f32 {
  let point = abs(uv - vec2f(0.5)) - vec2f(0.5 - radius);
  let distance = length(max(point, vec2f(0.0))) + min(max(point.x, point.y), 0.0) - radius;
  let edge = max(0.002, feather);
  return 1.0 - smoothstep(-edge, edge, distance);
}

fn rec709ToLinearChannel(value: f32) -> f32 {
  if (value < 0.081) { return max(0.0, value) / 4.5; }
  return pow((value + 0.099) / 1.099, 1.0 / 0.45);
}

fn rec709ToLinear(rgb: vec3f) -> vec3f {
  return vec3f(rec709ToLinearChannel(rgb.r), rec709ToLinearChannel(rgb.g), rec709ToLinearChannel(rgb.b));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let alpha = graphic.color.a * graphic.params.z * graphicAlpha(input.uv, graphic.params.x, graphic.params.w);
  return vec4f(rec709ToLinear(graphic.color.rgb), alpha);
}
`;

const TEXT_SHADER = /* wgsl */ `
struct TextUniforms {
  offsetAndScale: vec4f,
  uvBounds: vec4f,
  fill: vec4f,
  outline: vec4f,
  shadow: vec4f,
  params: vec4f,
  shadowAndTransform: vec4f,
}

@group(0) @binding(0) var glyphAtlas: texture_2d<f32>;
@group(0) @binding(1) var glyphSampler: sampler;
@group(0) @binding(2) var<uniform> glyph: TextUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );
  let angle = glyph.shadowAndTransform.z;
  let scaled = positions[index] * glyph.offsetAndScale.zw;
  let rotated = vec2f(
    scaled.x * cos(angle) - scaled.y * sin(angle),
    scaled.x * sin(angle) + scaled.y * cos(angle)
  );
  var output: VertexOutput;
  output.position = vec4f(rotated + glyph.offsetAndScale.xy, 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

fn atlasUv(localUv: vec2f) -> vec2f {
  return mix(glyph.uvBounds.xy, glyph.uvBounds.zw, localUv);
}

fn over(backdrop: vec4f, source: vec4f) -> vec4f {
  let alpha = source.a + backdrop.a * (1.0 - source.a);
  if (alpha <= 0.00001) { return vec4f(0.0); }
  let color = (source.rgb * source.a + backdrop.rgb * backdrop.a * (1.0 - source.a)) / alpha;
  return vec4f(color, alpha);
}

fn rec709ToLinearChannel(value: f32) -> f32 {
  if (value < 0.081) { return max(0.0, value) / 4.5; }
  return pow((value + 0.099) / 1.099, 1.0 / 0.45);
}

fn rec709ToLinear(rgb: vec3f) -> vec3f {
  return vec3f(rec709ToLinearChannel(rgb.r), rec709ToLinearChannel(rgb.g), rec709ToLinearChannel(rgb.b));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let distance = textureSample(glyphAtlas, glyphSampler, atlasUv(input.uv)).r;
  let edge = max(0.003, fwidth(distance));
  let fillAlpha = smoothstep(0.5 - edge, 0.5 + edge, distance);
  let outlineAlpha = smoothstep(
    0.5 - glyph.params.y - edge,
    0.5 - glyph.params.y + edge,
    distance
  );
  let shadowUv = input.uv - glyph.shadowAndTransform.xy;
  let shadowDistance = textureSample(glyphAtlas, glyphSampler, atlasUv(shadowUv)).r;
  let shadowAlpha = smoothstep(
    0.5 - glyph.params.z - edge,
    0.5 + glyph.params.z + edge,
    shadowDistance
  );
  var result = vec4f(rec709ToLinear(glyph.shadow.rgb), glyph.shadow.a * shadowAlpha);
  result = over(result, vec4f(rec709ToLinear(glyph.outline.rgb), glyph.outline.a * outlineAlpha));
  result = over(result, vec4f(rec709ToLinear(glyph.fill.rgb), glyph.fill.a * fillAlpha));
  return vec4f(result.rgb, result.a * glyph.params.x);
}
`;

const OUTPUT_SHADER = /* wgsl */ `
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(sceneTexture, sceneSampler, input.uv);
  let bounded = max(sampled.rgb / max(sampled.a, 0.00001), vec3f(0.0));
  let low = bounded * 4.5;
  let high = 1.099 * pow(bounded, vec3f(0.45)) - 0.099;
  return vec4f(select(low, high, bounded >= vec3f(0.018)) * sampled.a, sampled.a);
}
`;

const COMPOSITE_SHADER = /* wgsl */ `
struct CompositeUniforms { modeAndPadding: vec4f, }
@group(0) @binding(0) var backdropTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var compositeSampler: sampler;
@group(0) @binding(3) var<uniform> composite: CompositeUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

fn blend(backdrop: vec3f, source: vec3f) -> vec3f {
  let mode = composite.modeAndPadding.x;
  if (mode < 0.5) { return source; }
  if (mode < 1.5) { return backdrop * source; }
  if (mode < 2.5) { return 1.0 - (1.0 - backdrop) * (1.0 - source); }
  if (mode < 3.5) {
    let low = 2.0 * backdrop * source;
    let high = 1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source);
    return select(low, high, backdrop >= vec3f(0.5));
  }
  if (mode < 4.5) { return min(backdrop, source); }
  return max(backdrop, source);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let backdropSample = textureSample(backdropTexture, compositeSampler, input.uv);
  let sourceSample = textureSample(sourceTexture, compositeSampler, input.uv);
  let backdrop = backdropSample.rgb / max(backdropSample.a, 0.00001);
  let source = sourceSample.rgb / max(sourceSample.a, 0.00001);
  let alpha = sourceSample.a + backdropSample.a * (1.0 - sourceSample.a);
  let mixed = blend(backdrop, source);
  let premultiplied =
    (1.0 - sourceSample.a) * backdropSample.rgb +
    (1.0 - backdropSample.a) * sourceSample.rgb +
    backdropSample.a * sourceSample.a * mixed;
  return vec4f(premultiplied, alpha);
}
`;

export const LAYER_UNIFORM_BYTE_SIZE = 192;
export const GRAPHIC_UNIFORM_BYTE_SIZE = 64;
export const TEXT_UNIFORM_BYTE_SIZE = 112;
export const COMPOSITE_UNIFORM_BYTE_SIZE = 16;

export function packCompositeUniform(blendMode: string): Float32Array {
  const mode = { normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5 }[blendMode];
  return new Float32Array([mode ?? 0, 0, 0, 0]);
}

const DEFAULT_ADJUSTMENT: ColorAdjustment = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
};

function clockwiseRadians(rotation: number): number {
  return rotation === 0 ? 0 : (-rotation * Math.PI) / 180;
}

export function rec709ChannelToLinear(value: number): number {
  const bounded = Math.max(0, value);
  return bounded < 0.081 ? bounded / 4.5 : ((bounded + 0.099) / 1.099) ** (1 / 0.45);
}

function linearWorkingColor(color: CompositorColor): CompositorColor {
  return [
    rec709ChannelToLinear(color[0]),
    rec709ChannelToLinear(color[1]),
    rec709ChannelToLinear(color[2]),
    color[3],
  ];
}

export interface LayerUniformOptions {
  uvScaleX?: number;
  uvScaleY?: number;
  uvOffsetX?: number;
  uvOffsetY?: number;
  cornerRadiusFraction?: number;
  colorAdjustment?: ColorAdjustment;
  transition?: CompositorLayer["transition"];
  visualEffects?: VisualEffectSettings;
  inputColor?: InputColorTransform | "linear";
  output?: { width: number; height: number };
}

export function packLayerUniform(
  transform: Transform,
  fitX: number,
  fitY: number,
  options: LayerUniformOptions = {},
): Float32Array {
  const adjustment = options.colorAdjustment ?? DEFAULT_ADJUSTMENT;
  const transition = options.transition;
  const effects = options.visualEffects;
  const output = options.output ?? { width: 1, height: 1 };
  const inputColor = options.inputColor ?? "linear";
  const inputColorMode =
    inputColor === "linear" ? 0 : { rec709: 1, hlg: 2, pq: 3 }[inputColor.transfer];
  const inputPrimariesMode = inputColor === "linear" || inputColor.primaries === "rec709" ? 0 : 1;
  const direction = transition ? { left: 0, right: 1, up: 2, down: 3 }[transition.direction] : 0;
  return new Float32Array([
    transform.x,
    -transform.y,
    transform.scaleX * fitX,
    transform.scaleY * fitY,
    transform.opacity,
    options.cornerRadiusFraction ?? 0,
    clockwiseRadians(transform.rotation),
    0,
    options.uvScaleX ?? 1,
    options.uvScaleY ?? 1,
    options.uvOffsetX ?? 0,
    options.uvOffsetY ?? 0,
    adjustment.exposure,
    adjustment.contrast,
    adjustment.saturation,
    adjustment.temperature,
    adjustment.tint,
    adjustment.highlights ?? 0,
    adjustment.shadows ?? 0,
    inputColor === "linear" || !inputColor.toneMap ? 0 : 1,
    transition?.kind === "wipe" ? 1 : transition?.kind === "blur" ? 2 : 0,
    transition?.progress ?? 0,
    direction,
    transition?.softness ?? 0,
    transition?.intensity ?? 0,
    0,
    0,
    0,
    (effects?.blurPx ?? 0) / Math.max(1, Math.min(output.width, output.height)),
    effects?.vignetteAmount ?? 0,
    effects?.vignetteSoftness ?? 0.5,
    effects?.grainAmount ?? 0,
    effects?.grainSize ?? 1,
    effects?.chromaTolerance ?? 0,
    effects?.shadowBlur
      ? effects.shadowBlur / Math.max(1, Math.min(output.width, output.height))
      : 0,
    inputPrimariesMode,
    ...(effects?.chromaColor ?? [0, 1, 0, 1]),
    ...(effects?.shadowColor ?? [0, 0, 0, 0]),
    (effects?.shadowX ?? 0) / Math.max(1, Math.abs(transform.scaleX) * output.width),
    (effects?.shadowY ?? 0) / Math.max(1, Math.abs(transform.scaleY) * output.height),
    effects?.shadowBlur
      ? effects.shadowBlur / Math.max(1, Math.min(output.width, output.height))
      : 0,
    inputColorMode,
  ]);
}

export interface CompositorLayer {
  id?: string;
  trackId?: string;
  frame: VideoFrame;
  transform: Transform;
  cornerRadiusPx?: number;
  inputColor?: InputColorTransform;
  colorAdjustment?: ColorAdjustment;
  visualEffects?: VisualEffectSettings;
  blendMode?: string;
  groupDepth?: number;
  masked?: boolean;
  maskRect?: CompositorMaskRect;
  transition?: {
    kind: "wipe" | "blur";
    progress: number;
    direction: "left" | "right" | "up" | "down";
    softness: number;
    intensity: number;
  };
  order?: number;
}

export interface CompositorGraphicLayer {
  id?: string;
  trackId?: string;
  kind: "solid";
  transform: Transform;
  color: readonly [number, number, number, number];
  cornerRadiusPx?: number;
  blurPx?: number;
  blendMode?: string;
  groupDepth?: number;
  maskRect?: CompositorMaskRect;
  order?: number;
}

export interface CompositorTextLayer {
  id?: string;
  trackId?: string;
  text: string;
  originX: number;
  originY: number;
  maxWidth: number;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  color: CompositorColor;
  outlineColor: CompositorColor;
  outlineWidth: number;
  shadowColor: CompositorColor;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  opacity: number;
  scale: number;
  rotation: number;
  blendMode?: string;
  groupDepth?: number;
  maskRect?: CompositorMaskRect;
  emphasis?: {
    start: number;
    end: number;
    color: CompositorColor;
    scale: number;
  };
  order?: number;
}

export type CompositorColor = readonly [number, number, number, number];
export interface CompositorMaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositorMetrics {
  gpuSubmitCpuMs: number;
  submittedFrames: number;
  activeFrames: number;
  deviceLostCount: number;
  outputWidth: number;
  outputHeight: number;
}

export interface PreviewCompositor {
  initialize(): Promise<void>;
  render(
    layers: CompositorLayer[],
    output?: { width: number; height: number },
    graphics?: readonly CompositorGraphicLayer[],
    background?: CompositorColor,
    text?: readonly CompositorTextLayer[],
    adjustments?: readonly CompositorAdjustmentGroup[],
  ): void;
  readonly metrics: CompositorMetrics;
  destroy(): void;
}

export interface CompositorAdjustmentGroup {
  id: string;
  targetTrackIds: readonly string[];
  belowTrackIds: readonly string[];
  colorAdjustment: ColorAdjustment;
  visualEffects: VisualEffectSettings;
}

export interface WebGpuCompositorOptions {
  onError?: (error: Error) => void;
  autoResize?: boolean;
  textRendering?: "production" | "disabled";
}

type DrawItem =
  | { id: string; kind: "media"; order: number; layer: CompositorLayer }
  | { id: string; kind: "graphic"; order: number; graphic: CompositorGraphicLayer }
  | { id: string; kind: "text"; order: number; glyph: TextGlyphDraw };

type RenderOperation =
  | { kind: "item"; order: number; item: DrawItem }
  | {
      kind: "adjustment";
      order: number;
      adjustment: CompositorAdjustmentGroup;
      items: DrawItem[];
    };

type AdjustmentRenderOperation = Extract<RenderOperation, { kind: "adjustment" }>;

function graphLayer(item: DrawItem): RenderGraphLayer {
  if (item.kind === "graphic") {
    return {
      id: item.id,
      kind: item.kind,
      painterOrder: item.order,
      effectCount: 0,
      masked: Boolean(item.graphic.maskRect),
      groupDepth: item.graphic.groupDepth ?? 0,
      blendMode: item.graphic.blendMode ?? "normal",
    };
  }
  if (item.kind === "text")
    return {
      id: item.id,
      kind: item.kind,
      painterOrder: item.order,
      effectCount: 0,
      masked: Boolean(item.glyph.maskRect),
      groupDepth: item.glyph.groupDepth,
      blendMode: item.glyph.blendMode,
    };
  return {
    id: item.id,
    kind: item.kind,
    painterOrder: item.order,
    effectCount: item.layer.visualEffects || item.layer.colorAdjustment ? 1 : 0,
    masked: Boolean(item.layer.maskRect) || (item.layer.masked ?? false),
    groupDepth: item.layer.groupDepth ?? 0,
    blendMode: item.layer.blendMode ?? "normal",
  };
}

function itemMask(item: DrawItem): CompositorMaskRect | undefined {
  if (item.kind === "media") return item.layer.maskRect;
  if (item.kind === "graphic") return item.graphic.maskRect;
  return item.glyph.maskRect;
}

function itemBlendMode(item: DrawItem): string {
  if (item.kind === "media") return item.layer.blendMode ?? "normal";
  if (item.kind === "graphic") return item.graphic.blendMode ?? "normal";
  return item.glyph.blendMode;
}

function itemTrackId(item: DrawItem): string | undefined {
  if (item.kind === "media") return item.layer.trackId;
  if (item.kind === "graphic") return item.graphic.trackId;
  return item.glyph.trackId;
}

function renderOperations(
  items: readonly DrawItem[],
  adjustments: readonly CompositorAdjustmentGroup[],
): RenderOperation[] {
  const claimed = new Set<string>();
  const groups = adjustments.flatMap((adjustment): AdjustmentRenderOperation[] => {
    const targets = new Set(adjustment.targetTrackIds);
    const grouped = items.filter((item) => {
      const trackId = itemTrackId(item);
      return trackId !== undefined && targets.has(trackId);
    });
    for (const item of grouped) {
      if (claimed.has(item.id))
        throw new Error(`Overlapping active adjustment groups target ${item.id}.`);
      claimed.add(item.id);
    }
    return grouped.length === 0
      ? []
      : [
          {
            kind: "adjustment",
            order:
              Math.max(
                ...items
                  .filter((item) => {
                    const trackId = itemTrackId(item);
                    return trackId !== undefined && adjustment.belowTrackIds.includes(trackId);
                  })
                  .map((item) => item.order),
                ...grouped.map((item) => item.order),
              ) + 0.5,
            adjustment,
            items: grouped,
          },
        ];
  });
  const operations: RenderOperation[] = [
    ...items
      .filter((item) => !claimed.has(item.id))
      .map((item): RenderOperation => ({ kind: "item", order: item.order, item })),
    ...groups,
  ];
  const byId = new Map(
    operations.map((operation) => [
      operation.kind === "item" ? operation.item.id : operation.adjustment.id,
      operation,
    ]),
  );
  const graphAdjustments: RenderGraphAdjustment[] = groups.map((operation) => ({
    id: operation.adjustment.id,
    targetLayerIds: operation.items.map((item) => item.id),
    painterOrder: operation.order,
    effectCount: 1,
  }));
  const graph = buildRenderGraph(items.map(graphLayer), graphAdjustments);
  return graph.painterOrder.map((id) => byId.get(id)!);
}

function applyScissor(
  pass: GPURenderPassEncoder,
  mask: CompositorMaskRect | undefined,
  output: { width: number; height: number },
): void {
  const x = Math.max(0, Math.floor(mask?.x ?? 0));
  const y = Math.max(0, Math.floor(mask?.y ?? 0));
  const right = Math.min(output.width, Math.ceil((mask?.x ?? 0) + (mask?.width ?? output.width)));
  const bottom = Math.min(
    output.height,
    Math.ceil((mask?.y ?? 0) + (mask?.height ?? output.height)),
  );
  pass.setScissorRect(x, y, Math.max(0, right - x), Math.max(0, bottom - y));
}

function texturePass(
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  clear: CompositorColor,
): GPURenderPassEncoder {
  return encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
}

interface TextGlyphDraw {
  atlas: AtlasGlyph;
  transform: Transform;
  fill: CompositorColor;
  outline: CompositorColor;
  shadow: CompositorColor;
  outlineDistance: number;
  shadowDistance: number;
  shadowOffset: readonly [number, number];
  order: number;
  trackId?: string;
  blendMode: string;
  groupDepth: number;
  maskRect?: CompositorMaskRect;
}

function relativeRadius(
  radiusPx: number,
  transform: Transform,
  output: { width: number; height: number },
): number {
  const width = Math.abs(transform.scaleX) * Math.max(1, output.width);
  const height = Math.abs(transform.scaleY) * Math.max(1, output.height);
  return Math.min(0.5, Math.max(0, radiusPx) / Math.max(1, Math.min(width, height)));
}

function mediaFit(
  layer: CompositorLayer,
  output: { width: number; height: number },
): { fitX: number; fitY: number; uvScaleX: number; uvScaleY: number } {
  const sourceAspect =
    Math.max(1, layer.frame.displayWidth) / Math.max(1, layer.frame.displayHeight);
  const targetAspect =
    (Math.max(0.000_1, Math.abs(layer.transform.scaleX)) * Math.max(1, output.width)) /
    (Math.max(0.000_1, Math.abs(layer.transform.scaleY)) * Math.max(1, output.height));
  const fit = { fitX: 1, fitY: 1, uvScaleX: 1, uvScaleY: 1 };
  if (layer.transform.fit === "contain") {
    if (sourceAspect > targetAspect) fit.fitY = targetAspect / sourceAspect;
    else fit.fitX = sourceAspect / targetAspect;
  } else if (layer.transform.fit === "cover") {
    if (sourceAspect > targetAspect) fit.uvScaleX = targetAspect / sourceAspect;
    else fit.uvScaleY = sourceAspect / targetAspect;
  }
  return fit;
}

function packGraphicUniform(
  graphic: CompositorGraphicLayer,
  radiusFraction: number,
  blurFraction: number,
): Float32Array {
  return new Float32Array([
    graphic.transform.x,
    -graphic.transform.y,
    graphic.transform.scaleX,
    graphic.transform.scaleY,
    ...graphic.color,
    radiusFraction,
    0,
    graphic.transform.opacity,
    blurFraction,
    clockwiseRadians(graphic.transform.rotation),
    0,
    0,
    0,
  ]);
}

function packTextUniform(glyph: TextGlyphDraw): Float32Array {
  return new Float32Array([
    glyph.transform.x,
    -glyph.transform.y,
    glyph.transform.scaleX,
    glyph.transform.scaleY,
    ...glyph.atlas.uv,
    ...glyph.fill,
    ...glyph.outline,
    ...glyph.shadow,
    glyph.transform.opacity,
    glyph.outlineDistance,
    glyph.shadowDistance,
    0,
    glyph.shadowOffset[0],
    glyph.shadowOffset[1],
    clockwiseRadians(glyph.transform.rotation),
    0,
  ]);
}

interface ShapedLine {
  glyphs: ShapedAtlasGlyph[];
  advance: number;
  text: string;
  start: number;
}

function shapeLine(
  atlas: WebGpuGlyphAtlas,
  text: string,
  layer: CompositorTextLayer,
  start: number,
): ShapedLine {
  const glyphs = atlas.shape(text, layer.fontWeight);
  const fontScale = layer.fontSize / atlas.unitsPerEm;
  const advance = glyphs.reduce(
    (total, { shaped }, index) =>
      total + shaped.xAdvance * fontScale + (index === glyphs.length - 1 ? 0 : layer.letterSpacing),
    0,
  );
  return { glyphs, advance, text, start };
}

function wrappedParagraph(
  atlas: WebGpuGlyphAtlas,
  paragraph: string,
  layer: CompositorTextLayer,
  paragraphStart: number,
): ShapedLine[] {
  const words = [...paragraph.matchAll(/\S+/gu)].slice(0, 500);
  if (words.length === 0) return [shapeLine(atlas, "", layer, paragraphStart)];
  const lines: ShapedLine[] = [];
  let currentStart = words[0]!.index!;
  let currentEnd = currentStart + words[0]![0].length;
  for (const match of words.slice(1)) {
    const wordEnd = match.index! + match[0].length;
    const candidate = paragraph.slice(currentStart, wordEnd);
    if (
      shapeLine(atlas, candidate, layer, paragraphStart + currentStart).advance * layer.scale <=
      layer.maxWidth
    )
      currentEnd = wordEnd;
    else {
      lines.push(
        shapeLine(
          atlas,
          paragraph.slice(currentStart, currentEnd),
          layer,
          paragraphStart + currentStart,
        ),
      );
      currentStart = match.index!;
      currentEnd = wordEnd;
    }
  }
  lines.push(
    shapeLine(
      atlas,
      paragraph.slice(currentStart, currentEnd),
      layer,
      paragraphStart + currentStart,
    ),
  );
  return lines;
}

function wrappedLines(atlas: WebGpuGlyphAtlas, layer: CompositorTextLayer): ShapedLine[] {
  const text = layer.text.slice(0, 10_000);
  const lines: ShapedLine[] = [];
  let cursor = 0;
  for (const paragraph of text.split(/\r?\n/u)) {
    const start = text.indexOf(paragraph, cursor);
    lines.push(...wrappedParagraph(atlas, paragraph, layer, start));
    cursor = start + paragraph.length + 1;
  }
  return lines.slice(0, 100);
}

function emphasisByteRange(
  layer: CompositorTextLayer,
  line: ShapedLine,
): readonly [number, number] | null {
  const emphasis = layer.emphasis;
  if (!emphasis || emphasis.end <= line.start || emphasis.start >= line.start + line.text.length)
    return null;
  const localStart = Math.max(0, emphasis.start - line.start);
  const localEnd = Math.min(line.text.length, emphasis.end - line.start);
  const encoder = new TextEncoder();
  const byteStart = encoder.encode(line.text.slice(0, localStart)).length;
  const byteEnd = encoder.encode(line.text.slice(0, localEnd)).length;
  return [byteStart, byteEnd];
}

function glyphIsEmphasized(
  range: readonly [number, number] | null,
  glyph: ShapedAtlasGlyph,
): boolean {
  return Boolean(range && glyph.shaped.cluster >= range[0] && glyph.shaped.cluster < range[1]);
}

function lineStart(layer: CompositorTextLayer, line: ShapedLine): number {
  const advance = line.advance * layer.scale;
  if (layer.align === "center") return layer.originX + (layer.maxWidth - advance) / 2;
  if (layer.align === "right") return layer.originX + layer.maxWidth - advance;
  return layer.originX;
}

function rotatedCenter(
  x: number,
  y: number,
  anchorX: number,
  anchorY: number,
  rotation: number,
): { x: number; y: number } {
  if (rotation === 0) return { x, y };
  const radians = (rotation * Math.PI) / 180;
  const dx = x - anchorX;
  const dy = y - anchorY;
  return {
    x: anchorX + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: anchorY + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

function glyphTransform(
  layer: CompositorTextLayer,
  atlas: WebGpuGlyphAtlas,
  glyph: ShapedAtlasGlyph,
  cursorX: number,
  baselineY: number,
  anchor: { x: number; y: number },
  output: { width: number; height: number },
): Transform | null {
  if (!glyph.atlas) return null;
  const scale = (layer.fontSize / atlas.unitsPerEm) * layer.scale;
  const plane = glyph.atlas.plane;
  const left = cursorX + (glyph.shaped.xOffset + plane.left) * scale;
  const top = baselineY - (glyph.shaped.yOffset + plane.top) * scale;
  const width = (plane.right - plane.left) * scale;
  const height = (plane.top - plane.bottom) * scale;
  const center = rotatedCenter(
    left + width / 2,
    top + height / 2,
    anchor.x,
    anchor.y,
    layer.rotation,
  );
  return {
    x: (center.x / output.width) * 2 - 1,
    y: (center.y / output.height) * 2 - 1,
    scaleX: width / output.width,
    scaleY: height / output.height,
    rotation: layer.rotation,
    opacity: layer.opacity,
    fit: "fill",
  };
}

function glyphDraw(
  atlas: WebGpuGlyphAtlas,
  layer: CompositorTextLayer,
  glyph: ShapedAtlasGlyph,
  transform: Transform | null,
  output: { width: number; height: number },
  order: number,
  emphasized: boolean,
): TextGlyphDraw | null {
  if (!glyph.atlas || !transform) return null;
  const emphasisScale = emphasized ? (layer.emphasis?.scale ?? 1) : 1;
  const fontScale = (layer.fontSize * layer.scale) / atlas.unitsPerEm;
  const distancePixels = Math.max(1, glyph.atlas.distanceRange * fontScale);
  return {
    atlas: glyph.atlas,
    transform: {
      ...transform,
      scaleX: transform.scaleX * emphasisScale,
      scaleY: transform.scaleY * emphasisScale,
    },
    fill: emphasized ? (layer.emphasis?.color ?? layer.color) : layer.color,
    outline: layer.outlineColor,
    shadow: layer.shadowColor,
    outlineDistance: Math.min(0.3, Math.max(0, layer.outlineWidth / distancePixels)),
    shadowDistance: Math.min(0.3, Math.max(0, layer.shadowBlur / distancePixels)),
    shadowOffset: [
      layer.shadowX / Math.max(1, Math.abs(transform.scaleX) * output.width),
      layer.shadowY / Math.max(1, Math.abs(transform.scaleY) * output.height),
    ],
    order,
    ...(layer.trackId ? { trackId: layer.trackId } : {}),
    blendMode: layer.blendMode ?? "normal",
    groupDepth: layer.groupDepth ?? 0,
    ...(layer.maskRect ? { maskRect: layer.maskRect } : {}),
  };
}

function textGlyphs(
  atlas: WebGpuGlyphAtlas,
  layer: CompositorTextLayer,
  output: { width: number; height: number },
): TextGlyphDraw[] {
  const lines = wrappedLines(atlas, layer);
  const lineHeight = layer.fontSize * layer.lineHeight * layer.scale;
  const anchor = {
    x: layer.originX + layer.maxWidth / 2,
    y: layer.originY + (lines.length * lineHeight) / 2,
  };
  const result: TextGlyphDraw[] = [];
  let glyphOrder = 0;
  for (const [lineIndex, line] of lines.entries()) {
    let cursorX = lineStart(layer, line);
    const baselineY = layer.originY + layer.fontSize * layer.scale + lineIndex * lineHeight;
    const emphasisRange = emphasisByteRange(layer, line);
    for (const glyph of line.glyphs) {
      const transform = glyphTransform(layer, atlas, glyph, cursorX, baselineY, anchor, output);
      const draw = glyphDraw(
        atlas,
        layer,
        glyph,
        transform,
        output,
        (layer.order ?? 0) + glyphOrder / 10_000,
        glyphIsEmphasized(emphasisRange, glyph),
      );
      if (draw) result.push(draw);
      cursorX +=
        (glyph.shaped.xAdvance / atlas.unitsPerEm) * layer.fontSize * layer.scale +
        layer.letterSpacing * layer.scale;
      glyphOrder += 1;
    }
  }
  return result;
}

export class WebGpuCompositor implements PreviewCompositor {
  readonly #canvas: HTMLCanvasElement;
  readonly #onError: (error: Error) => void;
  readonly #autoResize: boolean;
  readonly #textRendering: "production" | "disabled";
  #context: GPUCanvasContext | null = null;
  #device: GPUDevice | null = null;
  #pipeline: GPURenderPipeline | null = null;
  #graphicPipeline: GPURenderPipeline | null = null;
  #textPipeline: GPURenderPipeline | null = null;
  #outputPipeline: GPURenderPipeline | null = null;
  #compositePipeline: GPURenderPipeline | null = null;
  #effectPipeline: GPURenderPipeline | null = null;
  readonly #texturePool = new BoundedRenderTexturePool(4);
  #glyphAtlas: WebGpuGlyphAtlas | null = null;
  #sampler: GPUSampler | null = null;
  #format: GPUTextureFormat | null = null;
  #deviceErrorListener: ((event: GPUUncapturedErrorEvent) => void) | null = null;
  #submittedFrames = 0;
  #lastSubmitCpuMs = 0;
  #deviceLostCount = 0;
  #destroyed = false;

  constructor(canvas: HTMLCanvasElement, options: WebGpuCompositorOptions = {}) {
    this.#canvas = canvas;
    this.#onError = options.onError ?? (() => undefined);
    this.#autoResize = options.autoResize ?? true;
    this.#textRendering = options.textRendering ?? "production";
  }

  async initialize(): Promise<void> {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    if (this.#destroyed) {
      device.destroy();
      return;
    }
    const context = this.#canvas.getContext("webgpu");
    if (!context) throw new Error("Could not create a WebGPU canvas context");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });
    this.#device = device;
    this.#context = context;
    this.#format = format;
    const deviceErrorListener = (event: GPUUncapturedErrorEvent) => {
      if (this.#device === device) {
        this.#pipeline = null;
        this.#graphicPipeline = null;
        this.#textPipeline = null;
        this.#outputPipeline = null;
        this.#compositePipeline = null;
        this.#effectPipeline = null;
      }
      this.#reportError(new Error(`WebGPU validation failed: ${event.error.message}`));
    };
    device.addEventListener("uncapturederror", deviceErrorListener);
    this.#deviceErrorListener = deviceErrorListener;
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const blend: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    try {
      const videoModule = device.createShaderModule({ code: VIDEO_SHADER });
      const effectModule = device.createShaderModule({ code: EFFECT_SHADER });
      const videoLayout = device.createBindGroupLayout({
        label: "cinesim-preview-layer-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "filtering" },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: LAYER_UNIFORM_BYTE_SIZE },
          },
        ],
      });
      const effectLayout = device.createBindGroupLayout({
        label: "cinesim-preview-effect-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          {
            binding: 2,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: LAYER_UNIFORM_BYTE_SIZE },
          },
        ],
      });
      const graphicModule = device.createShaderModule({ code: GRAPHIC_SHADER });
      const graphicLayout = device.createBindGroupLayout({
        label: "cinesim-preview-graphic-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: GRAPHIC_UNIFORM_BYTE_SIZE },
          },
        ],
      });
      const textModule = device.createShaderModule({ code: TEXT_SHADER });
      const textLayout = device.createBindGroupLayout({
        label: "cinesim-preview-text-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "float", viewDimension: "2d" },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          {
            binding: 2,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: TEXT_UNIFORM_BYTE_SIZE },
          },
        ],
      });
      const outputModule = device.createShaderModule({ code: OUTPUT_SHADER });
      const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });
      const outputLayout = device.createBindGroupLayout({
        label: "cinesim-preview-output-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "float", viewDimension: "2d" },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
      });
      const compositeLayout = device.createBindGroupLayout({
        label: "cinesim-preview-composite-layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          {
            binding: 3,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: COMPOSITE_UNIFORM_BYTE_SIZE },
          },
        ],
      });
      this.#pipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [videoLayout] }),
        vertex: { module: videoModule, entryPoint: "vertexMain" },
        fragment: {
          module: videoModule,
          entryPoint: "fragmentMain",
          targets: [{ format: WORKING_TEXTURE_FORMAT, blend }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.#effectPipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-effect-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [effectLayout] }),
        vertex: { module: effectModule, entryPoint: "vertexMain" },
        fragment: {
          module: effectModule,
          entryPoint: "fragmentMain",
          targets: [{ format: WORKING_TEXTURE_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.#graphicPipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-graphic-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [graphicLayout] }),
        vertex: { module: graphicModule, entryPoint: "vertexMain" },
        fragment: {
          module: graphicModule,
          entryPoint: "fragmentMain",
          targets: [{ format: WORKING_TEXTURE_FORMAT, blend }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.#textPipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-text-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [textLayout] }),
        vertex: { module: textModule, entryPoint: "vertexMain" },
        fragment: {
          module: textModule,
          entryPoint: "fragmentMain",
          targets: [{ format: WORKING_TEXTURE_FORMAT, blend }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.#outputPipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-output-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [outputLayout] }),
        vertex: { module: outputModule, entryPoint: "vertexMain" },
        fragment: { module: outputModule, entryPoint: "fragmentMain", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      this.#compositePipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-composite-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [compositeLayout] }),
        vertex: { module: compositeModule, entryPoint: "vertexMain" },
        fragment: {
          module: compositeModule,
          entryPoint: "fragmentMain",
          targets: [{ format: WORKING_TEXTURE_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
      });
      if (this.#textRendering === "production") {
        const { WebGpuGlyphAtlas } = await import("./glyph-atlas");
        this.#glyphAtlas = await WebGpuGlyphAtlas.create(device);
      }
    } catch (error) {
      device.removeEventListener("uncapturederror", deviceErrorListener);
      if (this.#device === device) {
        this.#texturePool.destroy();
        context.unconfigure();
        this.#device = null;
        this.#context = null;
        this.#sampler = null;
        this.#format = null;
        this.#deviceErrorListener = null;
        this.#pipeline = null;
        this.#graphicPipeline = null;
        this.#textPipeline = null;
        this.#outputPipeline = null;
        this.#compositePipeline = null;
        this.#effectPipeline = null;
        this.#glyphAtlas?.destroy();
        this.#glyphAtlas = null;
      }
      device.destroy();
      throw error;
    }
    if (this.#destroyed || this.#device !== device) {
      device.removeEventListener("uncapturederror", deviceErrorListener);
      device.destroy();
      return;
    }
    void device.lost.then((info) => {
      if (this.#device !== device) return;
      device.removeEventListener("uncapturederror", deviceErrorListener);
      this.#deviceErrorListener = null;
      this.#deviceLostCount += 1;
      this.#texturePool.destroy();
      this.#device = null;
      this.#pipeline = null;
      this.#graphicPipeline = null;
      this.#textPipeline = null;
      this.#outputPipeline = null;
      this.#compositePipeline = null;
      this.#effectPipeline = null;
      this.#glyphAtlas = null;
      if (!this.#destroyed && info.reason !== "destroyed")
        void this.initialize().catch((error: unknown) => this.#reportError(error));
    });
    this.resize();
  }

  resize(): void {
    if (!this.#autoResize) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.#canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.#canvas.clientHeight * ratio));
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
  }

  setOutputSize(width: number, height: number): void {
    if (this.#autoResize) throw new Error("Manual output size requires autoResize: false");
    this.#canvas.width = Math.max(1, Math.round(width));
    this.#canvas.height = Math.max(1, Math.round(height));
  }

  async capturePng(): Promise<ArrayBuffer> {
    await this.waitForSubmittedWork();
    const blob = await new Promise<Blob>((resolve, reject) => {
      this.#canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("WebGPU frame could not be encoded"));
      }, "image/png");
    });
    return blob.arrayBuffer();
  }

  async waitForSubmittedWork(): Promise<void> {
    if (!this.#device || this.#destroyed) throw new Error("WebGPU compositor is unavailable");
    await this.#device.queue.onSubmittedWorkDone();
  }

  #drawGraphic(
    pass: GPURenderPassEncoder,
    graphic: CompositorGraphicLayer,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    const radius = relativeRadius(graphic.cornerRadiusPx ?? 0, graphic.transform, output);
    const blur = relativeRadius(graphic.blurPx ?? 0, graphic.transform, output);
    const uniform = this.#device!.createBuffer({
      label: "cinesim-preview-graphic-uniform",
      size: GRAPHIC_UNIFORM_BYTE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    transientBuffers.push(uniform);
    this.#device!.queue.writeBuffer(uniform, 0, packGraphicUniform(graphic, radius, blur));
    pass.setPipeline(this.#graphicPipeline!);
    pass.setBindGroup(
      0,
      this.#device!.createBindGroup({
        label: "cinesim-preview-graphic-bind-group",
        layout: this.#graphicPipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      }),
    );
    pass.draw(6);
  }

  #drawMedia(
    pass: GPURenderPassEncoder,
    layer: CompositorLayer,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    const fit = mediaFit(layer, output);
    const uniform = this.#device!.createBuffer({
      label: "cinesim-preview-layer-uniform",
      size: LAYER_UNIFORM_BYTE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    transientBuffers.push(uniform);
    this.#device!.queue.writeBuffer(
      uniform,
      0,
      packLayerUniform(layer.transform, fit.fitX, fit.fitY, {
        uvScaleX: fit.uvScaleX,
        uvScaleY: fit.uvScaleY,
        uvOffsetX: (1 - fit.uvScaleX) / 2,
        uvOffsetY: (1 - fit.uvScaleY) / 2,
        cornerRadiusFraction: relativeRadius(layer.cornerRadiusPx ?? 0, layer.transform, output),
        ...(layer.colorAdjustment === undefined ? {} : { colorAdjustment: layer.colorAdjustment }),
        inputColor: layer.inputColor ?? {
          transfer: "rec709",
          primaries: "rec709",
          toneMap: false,
        },
        ...(layer.transition === undefined ? {} : { transition: layer.transition }),
        ...(layer.visualEffects === undefined ? {} : { visualEffects: layer.visualEffects }),
        output,
      }),
    );
    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(
      0,
      this.#device!.createBindGroup({
        label: "cinesim-preview-layer-bind-group",
        layout: this.#pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.#device!.importExternalTexture({ source: layer.frame }) },
          { binding: 1, resource: this.#sampler! },
          { binding: 2, resource: { buffer: uniform } },
        ],
      }),
    );
    pass.draw(6);
  }

  #drawText(pass: GPURenderPassEncoder, glyph: TextGlyphDraw, transientBuffers: GPUBuffer[]): void {
    const uniform = this.#device!.createBuffer({
      label: "cinesim-preview-text-uniform",
      size: TEXT_UNIFORM_BYTE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    transientBuffers.push(uniform);
    this.#device!.queue.writeBuffer(uniform, 0, packTextUniform(glyph));
    pass.setPipeline(this.#textPipeline!);
    pass.setBindGroup(
      0,
      this.#device!.createBindGroup({
        label: "cinesim-preview-text-bind-group",
        layout: this.#textPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: glyph.atlas.texture.createView() },
          { binding: 1, resource: this.#sampler! },
          { binding: 2, resource: { buffer: uniform } },
        ],
      }),
    );
    pass.draw(6);
  }

  #orderedItems(
    layers: readonly CompositorLayer[],
    graphics: readonly CompositorGraphicLayer[],
    text: readonly CompositorTextLayer[],
    output: { width: number; height: number },
  ): DrawItem[] {
    const items: DrawItem[] = [
      ...layers.map((layer, index) => ({
        id: layer.id ?? `media:${index}`,
        kind: "media" as const,
        order: layer.order ?? index,
        layer,
      })),
      ...graphics.map((graphic, index) => ({
        id: graphic.id ?? `graphic:${index}`,
        kind: "graphic" as const,
        order: graphic.order ?? layers.length + index,
        graphic,
      })),
      ...(this.#glyphAtlas
        ? text.flatMap((layer, textIndex) =>
            textGlyphs(this.#glyphAtlas!, layer, output).map((glyph, glyphIndex) => ({
              id: `${layer.id ?? `text:${textIndex}`}:glyph:${glyphIndex}`,
              kind: "text" as const,
              order: glyph.order,
              glyph,
            })),
          )
        : []),
    ];
    return items;
  }

  #drawItem(
    pass: GPURenderPassEncoder,
    item: DrawItem,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    applyScissor(pass, itemMask(item), output);
    if (item.kind === "graphic") this.#drawGraphic(pass, item.graphic, output, transientBuffers);
    else if (item.kind === "text") this.#drawText(pass, item.glyph, transientBuffers);
    else this.#drawMedia(pass, item.layer, output, transientBuffers);
  }

  #drawComposite(
    pass: GPURenderPassEncoder,
    backdrop: GPUTexture,
    source: GPUTexture,
    blendMode: string,
    transientBuffers: GPUBuffer[],
  ): void {
    const uniform = this.#device!.createBuffer({
      label: "cinesim-preview-composite-uniform",
      size: COMPOSITE_UNIFORM_BYTE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    transientBuffers.push(uniform);
    this.#device!.queue.writeBuffer(uniform, 0, packCompositeUniform(blendMode));
    pass.setPipeline(this.#compositePipeline!);
    pass.setBindGroup(
      0,
      this.#device!.createBindGroup({
        label: "cinesim-preview-composite-bind-group",
        layout: this.#compositePipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: backdrop.createView() },
          { binding: 1, resource: source.createView() },
          { binding: 2, resource: this.#sampler! },
          { binding: 3, resource: { buffer: uniform } },
        ],
      }),
    );
    pass.draw(6);
  }

  #drawEffect(
    pass: GPURenderPassEncoder,
    source: GPUTexture,
    adjustment: CompositorAdjustmentGroup,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    const uniform = this.#device!.createBuffer({
      label: "cinesim-preview-effect-uniform",
      size: LAYER_UNIFORM_BYTE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    transientBuffers.push(uniform);
    this.#device!.queue.writeBuffer(
      uniform,
      0,
      packLayerUniform(
        { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, fit: "fill" },
        1,
        1,
        {
          colorAdjustment: adjustment.colorAdjustment,
          visualEffects: adjustment.visualEffects,
          inputColor: "linear",
          output,
        },
      ),
    );
    pass.setPipeline(this.#effectPipeline!);
    pass.setBindGroup(
      0,
      this.#device!.createBindGroup({
        label: "cinesim-preview-effect-bind-group",
        layout: this.#effectPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: this.#sampler! },
          { binding: 2, resource: { buffer: uniform } },
        ],
      }),
    );
    pass.draw(6);
  }

  #isolateItem(
    encoder: GPUCommandEncoder,
    source: GPUTexture,
    item: DrawItem,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    const pass = texturePass(encoder, source, [0, 0, 0, 0]);
    this.#drawItem(pass, item, output, transientBuffers);
    pass.end();
  }

  #compositeTo(
    encoder: GPUCommandEncoder,
    backdrop: GPUTexture,
    source: GPUTexture,
    target: GPUTexture,
    blendMode: string,
    transientBuffers: GPUBuffer[],
  ): void {
    const pass = texturePass(encoder, target, [0, 0, 0, 0]);
    this.#drawComposite(pass, backdrop, source, blendMode, transientBuffers);
    pass.end();
  }

  #renderAdjustment(
    encoder: GPUCommandEncoder,
    operation: AdjustmentRenderOperation,
    current: GPUTexture,
    target: GPUTexture,
    source: GPUTexture,
    effect: GPUTexture,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    texturePass(encoder, target, [0, 0, 0, 0]).end();
    let groupCurrent = target;
    for (const item of operation.items) {
      this.#isolateItem(encoder, source, item, output, transientBuffers);
      const groupNext = groupCurrent === target ? effect : target;
      this.#compositeTo(
        encoder,
        groupCurrent,
        source,
        groupNext,
        itemBlendMode(item),
        transientBuffers,
      );
      groupCurrent = groupNext;
    }
    const effectPass = texturePass(encoder, source, [0, 0, 0, 0]);
    this.#drawEffect(effectPass, groupCurrent, operation.adjustment, output, transientBuffers);
    effectPass.end();
    this.#compositeTo(encoder, current, source, target, "normal", transientBuffers);
  }

  #executeOperations(
    encoder: GPUCommandEncoder,
    scenes: readonly [GPUTexture, GPUTexture],
    source: GPUTexture,
    effect: GPUTexture,
    operations: readonly RenderOperation[],
    background: CompositorColor,
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): number {
    let sceneIndex = 0;
    texturePass(encoder, scenes[sceneIndex]!, linearWorkingColor(background)).end();
    for (const operation of operations) {
      const nextIndex = sceneIndex === 0 ? 1 : 0;
      if (operation.kind === "adjustment")
        this.#renderAdjustment(
          encoder,
          operation,
          scenes[sceneIndex]!,
          scenes[nextIndex]!,
          source,
          effect,
          output,
          transientBuffers,
        );
      else {
        this.#isolateItem(encoder, source, operation.item, output, transientBuffers);
        this.#compositeTo(
          encoder,
          scenes[sceneIndex]!,
          source,
          scenes[nextIndex]!,
          itemBlendMode(operation.item),
          transientBuffers,
        );
      }
      sceneIndex = nextIndex;
    }
    return sceneIndex;
  }

  #drawOutput(pass: GPURenderPassEncoder, texture: GPUTexture): void {
    pass.setPipeline(this.#outputPipeline!);
    pass.setBindGroup(
      0,
      this.#device!.createBindGroup({
        label: "cinesim-preview-output-bind-group",
        layout: this.#outputPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: this.#sampler! },
        ],
      }),
    );
    pass.draw(6);
  }

  render(
    layers: CompositorLayer[],
    output = { width: this.#canvas.width, height: this.#canvas.height },
    graphics: readonly CompositorGraphicLayer[] = [],
    background: CompositorColor = [0.035, 0.035, 0.043, 1],
    text: readonly CompositorTextLayer[] = [],
    adjustments: readonly CompositorAdjustmentGroup[] = [],
  ): void {
    if (
      !this.#device ||
      !this.#context ||
      !this.#pipeline ||
      !this.#graphicPipeline ||
      !this.#textPipeline ||
      !this.#outputPipeline ||
      !this.#compositePipeline ||
      !this.#effectPipeline ||
      !this.#sampler ||
      !this.#format
    ) {
      for (const layer of layers) layer.frame.close();
      return;
    }
    const started = performance.now();
    const transientBuffers: GPUBuffer[] = [];
    let submitted = false;
    let failure: unknown;
    try {
      this.resize();
      const encoder = this.#device.createCommandEncoder();
      const width = Math.max(1, Math.round(output.width));
      const height = Math.max(1, Math.round(output.height));
      const scenes: [GPUTexture, GPUTexture] = [
        this.#texturePool.acquire(this.#device, width, height, WORKING_TEXTURE_FORMAT, "scene-a"),
        this.#texturePool.acquire(this.#device, width, height, WORKING_TEXTURE_FORMAT, "scene-b"),
      ];
      const source = this.#texturePool.acquire(
        this.#device,
        width,
        height,
        WORKING_TEXTURE_FORMAT,
        "source",
      );
      const effect = this.#texturePool.acquire(
        this.#device,
        width,
        height,
        WORKING_TEXTURE_FORMAT,
        "effect",
      );
      const operations = renderOperations(
        this.#orderedItems(layers, graphics, text, output),
        adjustments,
      );
      const sceneIndex = this.#executeOperations(
        encoder,
        scenes,
        source,
        effect,
        operations,
        background,
        output,
        transientBuffers,
      );
      const outputPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.#context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      this.#drawOutput(outputPass, scenes[sceneIndex]!);
      outputPass.end();
      this.#device.queue.submit([encoder.finish()]);
      submitted = true;
      void this.#device.queue.onSubmittedWorkDone().then(
        () => transientBuffers.forEach((buffer) => buffer.destroy()),
        (error: unknown) => {
          transientBuffers.forEach((buffer) => buffer.destroy());
          this.#reportError(error);
        },
      );
      this.#submittedFrames += 1;
      this.#lastSubmitCpuMs = performance.now() - started;
    } catch (error) {
      failure = error;
    } finally {
      for (const layer of layers) layer.frame.close();
      if (!submitted) transientBuffers.forEach((buffer) => buffer.destroy());
    }
    if (failure !== undefined) this.#reportError(failure);
  }

  get metrics(): CompositorMetrics {
    return {
      gpuSubmitCpuMs: this.#lastSubmitCpuMs,
      submittedFrames: this.#submittedFrames,
      activeFrames: 0,
      deviceLostCount: this.#deviceLostCount,
      outputWidth: this.#canvas.width,
      outputHeight: this.#canvas.height,
    };
  }

  destroy(): void {
    this.#destroyed = true;
    this.#glyphAtlas?.destroy();
    this.#texturePool.destroy();
    if (this.#device && this.#deviceErrorListener)
      this.#device.removeEventListener("uncapturederror", this.#deviceErrorListener);
    this.#context?.unconfigure();
    this.#device?.destroy();
    this.#context = null;
    this.#device = null;
    this.#pipeline = null;
    this.#graphicPipeline = null;
    this.#textPipeline = null;
    this.#outputPipeline = null;
    this.#compositePipeline = null;
    this.#effectPipeline = null;
    this.#glyphAtlas = null;
    this.#sampler = null;
    this.#format = null;
    this.#deviceErrorListener = null;
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Error observers must not create a second uncaptured error or rejected promise.
    }
  }
}
