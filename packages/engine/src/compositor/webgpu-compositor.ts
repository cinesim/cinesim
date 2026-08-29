import type { Transform } from "@cinesim/core";

const SHADER = /* wgsl */ `
struct LayerUniforms {
  offsetAndScale: vec4f,
  opacityAndPadding: vec4f,
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

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  return vec4f(color.rgb, color.a * layer.opacityAndPadding.x);
}
`;

export const LAYER_UNIFORM_BYTE_SIZE = 32;

export function packLayerUniform(transform: Transform, fitX: number, fitY: number): Float32Array {
  return new Float32Array([
    transform.x,
    -transform.y,
    transform.scaleX * fitX,
    transform.scaleY * fitY,
    transform.opacity,
    0,
    0,
    0,
  ]);
}

export interface CompositorLayer {
  frame: VideoFrame;
  transform: Transform;
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
  render(layers: CompositorLayer[], output?: { width: number; height: number }): void;
  readonly metrics: CompositorMetrics;
  destroy(): void;
}

export interface WebGpuCompositorOptions {
  onError?: (error: Error) => void;
}

export class WebGpuCompositor implements PreviewCompositor {
  readonly #canvas: HTMLCanvasElement;
  readonly #onError: (error: Error) => void;
  #context: GPUCanvasContext | null = null;
  #device: GPUDevice | null = null;
  #pipeline: GPURenderPipeline | null = null;
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
      if (this.#device === device) this.#pipeline = null;
      this.#reportError(new Error(`WebGPU validation failed: ${event.error.message}`));
    };
    device.addEventListener("uncapturederror", deviceErrorListener);
    this.#deviceErrorListener = deviceErrorListener;
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const module = device.createShaderModule({ code: SHADER });
    const bindGroupLayout = device.createBindGroupLayout({
      label: "cinesim-preview-layer-layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
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
    const pipelineLayout = device.createPipelineLayout({
      label: "cinesim-preview-pipeline-layout",
      bindGroupLayouts: [bindGroupLayout],
    });
    let pipeline: GPURenderPipeline;
    try {
      pipeline = await device.createRenderPipelineAsync({
        label: "cinesim-preview-pipeline",
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vertexMain" },
        fragment: {
          module,
          entryPoint: "fragmentMain",
          targets: [
            {
              format,
              blend: {
                color: {
                  srcFactor: "src-alpha",
                  dstFactor: "one-minus-src-alpha",
                  operation: "add",
                },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              },
            },
          ],
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
      }
      device.destroy();
      throw error;
    }
    if (this.#destroyed || this.#device !== device) {
      device.removeEventListener("uncapturederror", deviceErrorListener);
      device.destroy();
      return;
    }
    this.#pipeline = pipeline;
    void device.lost.then((info) => {
      if (this.#device !== device) return;
      device.removeEventListener("uncapturederror", deviceErrorListener);
      this.#deviceErrorListener = null;
      this.#deviceLostCount += 1;
      this.#device = null;
      this.#pipeline = null;
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

  render(
    layers: CompositorLayer[],
    output = { width: this.#canvas.width, height: this.#canvas.height },
    background: GPUColor = { r: 0.035, g: 0.035, b: 0.043, a: 1 },
  ): void {
    if (!this.#device || !this.#context || !this.#pipeline || !this.#sampler || !this.#format) {
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
            clearValue: background,
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this.#pipeline);
      for (const layer of layers) {
        const frameWidth = Math.max(1, layer.frame.displayWidth);
        const frameHeight = Math.max(1, layer.frame.displayHeight);
        const sourceAspect = frameWidth / frameHeight;
        const outputAspect = Math.max(1, output.width) / Math.max(1, output.height);
        let fitX = 1;
        let fitY = 1;
        if (layer.transform.fit === "contain") {
          if (sourceAspect > outputAspect) fitY = outputAspect / sourceAspect;
          else fitX = sourceAspect / outputAspect;
        } else if (layer.transform.fit === "cover") {
          if (sourceAspect > outputAspect) fitX = sourceAspect / outputAspect;
          else fitY = outputAspect / sourceAspect;
        }
        const uniform = this.#device.createBuffer({
          label: "cinesim-preview-layer-uniform",
          size: LAYER_UNIFORM_BYTE_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        transientBuffers.push(uniform);
        this.#device.queue.writeBuffer(uniform, 0, packLayerUniform(layer.transform, fitX, fitY));
        const bindGroup = this.#device.createBindGroup({
          label: "cinesim-preview-layer-bind-group",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.#device.importExternalTexture({ source: layer.frame }) },
            { binding: 1, resource: this.#sampler },
            { binding: 2, resource: { buffer: uniform } },
          ],
        });
        pass.setBindGroup(0, bindGroup);
        pass.draw(6);
      }
      pass.end();
      this.#device.queue.submit([encoder.finish()]);
      submitted = true;
      const completion = this.#device.queue.onSubmittedWorkDone();
      void completion.then(
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
