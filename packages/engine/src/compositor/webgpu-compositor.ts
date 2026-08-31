import type { Transform } from "@cinesim/core";
import type { ColorAdjustment } from "../playback/scene-resolver";

const VIDEO_SHADER = /* wgsl */ `
struct LayerUniforms {
  offsetAndScale: vec4f,
  opacityAndRadius: vec4f,
  uvScaleAndOffset: vec4f,
  colorAdjustOne: vec4f,
  colorAdjustTwo: vec4f,
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
  var output: VertexOutput;
  output.position = vec4f(
    positions[index] * layer.offsetAndScale.zw + layer.offsetAndScale.xy,
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv * layer.uvScaleAndOffset.xy + layer.uvScaleAndOffset.zw;
  let sampled = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv);
  let exposure = layer.colorAdjustOne.x;
  let contrast = layer.colorAdjustOne.y;
  let saturation = layer.colorAdjustOne.z;
  let temperature = layer.colorAdjustOne.w;
  let tint = layer.colorAdjustTwo.x;
  var rgb = sampled.rgb * exp2(exposure);
  rgb = (rgb - vec3f(0.5)) * contrast + vec3f(0.5);
  let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3f(luma), rgb, saturation);
  rgb += vec3f(temperature * 0.08, tint * 0.06, -temperature * 0.08);
  let alpha = sampled.a * layer.opacityAndRadius.x * roundedAlpha(input.uv, layer.opacityAndRadius.y);
  return vec4f(rgb, alpha);
}
`;

const GRAPHIC_SHADER = /* wgsl */ `
struct GraphicUniforms {
  offsetAndScale: vec4f,
  color: vec4f,
  params: vec4f,
  glyph: vec4u,
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
  var output: VertexOutput;
  output.position = vec4f(
    positions[index] * graphic.offsetAndScale.zw + graphic.offsetAndScale.xy,
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

fn glyphVisible(uv: vec2f) -> bool {
  let column = min(4u, u32(floor(uv.x * 5.0)));
  let row = min(6u, u32(floor(uv.y * 7.0)));
  let bit = row * 5u + column;
  if (bit < 32u) { return (graphic.glyph.x & (1u << bit)) != 0u; }
  return (graphic.glyph.y & (1u << (bit - 32u))) != 0u;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  if (graphic.params.y > 0.5 && !glyphVisible(input.uv)) { discard; }
  let alpha = graphic.color.a * graphic.params.z * graphicAlpha(input.uv, graphic.params.x, graphic.params.w);
  return vec4f(graphic.color.rgb, alpha);
}
`;

export const LAYER_UNIFORM_BYTE_SIZE = 80;
export const GRAPHIC_UNIFORM_BYTE_SIZE = 64;

const DEFAULT_ADJUSTMENT: ColorAdjustment = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
};

export interface LayerUniformOptions {
  uvScaleX?: number;
  uvScaleY?: number;
  uvOffsetX?: number;
  uvOffsetY?: number;
  cornerRadiusFraction?: number;
  colorAdjustment?: ColorAdjustment;
}

export function packLayerUniform(
  transform: Transform,
  fitX: number,
  fitY: number,
  options: LayerUniformOptions = {},
): Float32Array {
  const adjustment = options.colorAdjustment ?? DEFAULT_ADJUSTMENT;
  return new Float32Array([
    transform.x,
    -transform.y,
    transform.scaleX * fitX,
    transform.scaleY * fitY,
    transform.opacity,
    options.cornerRadiusFraction ?? 0,
    0,
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
    0,
    0,
    0,
  ]);
}

export interface CompositorLayer {
  frame: VideoFrame;
  transform: Transform;
  cornerRadiusPx?: number;
  colorAdjustment?: ColorAdjustment;
  order?: number;
}

export interface CompositorGraphicLayer {
  kind: "solid" | "glyph";
  transform: Transform;
  color: readonly [number, number, number, number];
  cornerRadiusPx?: number;
  blurPx?: number;
  glyph?: readonly [number, number];
  order?: number;
}

export type CompositorColor = readonly [number, number, number, number];

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
  ): void;
  readonly metrics: CompositorMetrics;
  destroy(): void;
}

export interface WebGpuCompositorOptions {
  onError?: (error: Error) => void;
}

type DrawItem =
  | { kind: "media"; order: number; layer: CompositorLayer }
  | { kind: "graphic"; order: number; graphic: CompositorGraphicLayer };

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
): ArrayBuffer {
  const buffer = new ArrayBuffer(GRAPHIC_UNIFORM_BYTE_SIZE);
  const floats = new Float32Array(buffer);
  floats.set(
    [
      graphic.transform.x,
      -graphic.transform.y,
      graphic.transform.scaleX,
      graphic.transform.scaleY,
      ...graphic.color,
      radiusFraction,
      graphic.kind === "glyph" ? 1 : 0,
      graphic.transform.opacity,
      blurFraction,
    ],
    0,
  );
  const integers = new Uint32Array(buffer);
  integers[12] = graphic.glyph?.[0] ?? 0;
  integers[13] = graphic.glyph?.[1] ?? 0;
  return buffer;
}

export class WebGpuCompositor implements PreviewCompositor {
  readonly #canvas: HTMLCanvasElement;
  readonly #onError: (error: Error) => void;
  #context: GPUCanvasContext | null = null;
  #device: GPUDevice | null = null;
  #pipeline: GPURenderPipeline | null = null;
  #graphicPipeline: GPURenderPipeline | null = null;
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
      this.#pipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [videoLayout] }),
        vertex: { module: videoModule, entryPoint: "vertexMain" },
        fragment: { module: videoModule, entryPoint: "fragmentMain", targets: [{ format, blend }] },
        primitive: { topology: "triangle-list" },
      });
      this.#graphicPipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-graphic-pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [graphicLayout] }),
        vertex: { module: graphicModule, entryPoint: "vertexMain" },
        fragment: {
          module: graphicModule,
          entryPoint: "fragmentMain",
          targets: [{ format, blend }],
        },
        primitive: { topology: "triangle-list" },
      });
    } catch (error) {
      device.removeEventListener("uncapturederror", deviceErrorListener);
      if (this.#device === device) {
        context.unconfigure();
        this.#device = null;
        this.#context = null;
        this.#sampler = null;
        this.#format = null;
        this.#deviceErrorListener = null;
        this.#pipeline = null;
        this.#graphicPipeline = null;
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
      this.#device = null;
      this.#pipeline = null;
      this.#graphicPipeline = null;
      if (!this.#destroyed && info.reason !== "destroyed")
        void this.initialize().catch((error: unknown) => this.#reportError(error));
    });
    this.resize();
  }

  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.#canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.#canvas.clientHeight * ratio));
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
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

  #drawItems(
    pass: GPURenderPassEncoder,
    layers: readonly CompositorLayer[],
    graphics: readonly CompositorGraphicLayer[],
    output: { width: number; height: number },
    transientBuffers: GPUBuffer[],
  ): void {
    const items: DrawItem[] = [
      ...layers.map((layer, index) => ({
        kind: "media" as const,
        order: layer.order ?? index,
        layer,
      })),
      ...graphics.map((graphic, index) => ({
        kind: "graphic" as const,
        order: graphic.order ?? layers.length + index,
        graphic,
      })),
    ];
    for (const item of items.sort((left, right) => left.order - right.order)) {
      if (item.kind === "graphic") this.#drawGraphic(pass, item.graphic, output, transientBuffers);
      else this.#drawMedia(pass, item.layer, output, transientBuffers);
    }
  }

  render(
    layers: CompositorLayer[],
    output = { width: this.#canvas.width, height: this.#canvas.height },
    graphics: readonly CompositorGraphicLayer[] = [],
    background: CompositorColor = [0.035, 0.035, 0.043, 1],
  ): void {
    if (
      !this.#device ||
      !this.#context ||
      !this.#pipeline ||
      !this.#graphicPipeline ||
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
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.#context.getCurrentTexture().createView(),
            clearValue: { r: background[0], g: background[1], b: background[2], a: background[3] },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      this.#drawItems(pass, layers, graphics, output, transientBuffers);
      pass.end();
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
    if (this.#device && this.#deviceErrorListener)
      this.#device.removeEventListener("uncapturederror", this.#deviceErrorListener);
    this.#context?.unconfigure();
    this.#device?.destroy();
    this.#context = null;
    this.#device = null;
    this.#pipeline = null;
    this.#graphicPipeline = null;
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
