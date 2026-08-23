import type { Transform } from "@cinesim/core";

const SHADER = /* wgsl */ `
struct LayerUniforms {
  offset: vec2f,
  scale: vec2f,
  opacity: f32,
  _padding: vec3f,
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
  output.position = vec4f(positions[index] * layer.scale + layer.offset, 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  return vec4f(color.rgb, color.a * layer.opacity);
}
`;

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

export class WebGpuCompositor implements PreviewCompositor {
  readonly #canvas: HTMLCanvasElement;
  #context: GPUCanvasContext | null = null;
  #device: GPUDevice | null = null;
  #pipeline: GPURenderPipeline | null = null;
  #sampler: GPUSampler | null = null;
  #format: GPUTextureFormat | null = null;
  #submittedFrames = 0;
  #lastSubmitCpuMs = 0;
  #deviceLostCount = 0;
  #destroyed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
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
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const module = device.createShaderModule({ code: SHADER });
    this.#pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vertexMain" },
      fragment: {
        module,
        entryPoint: "fragmentMain",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    void device.lost.then(() => {
      this.#deviceLostCount += 1;
      this.#device = null;
      this.#pipeline = null;
      if (!this.#destroyed) void this.initialize();
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
    this.resize();
    const encoder = this.#device.createCommandEncoder();
    const transientBuffers: GPUBuffer[] = [];
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
    try {
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
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        transientBuffers.push(uniform);
        this.#device.queue.writeBuffer(
          uniform,
          0,
          new Float32Array([
            layer.transform.x,
            -layer.transform.y,
            layer.transform.scaleX * fitX,
            layer.transform.scaleY * fitY,
            layer.transform.opacity,
            0,
            0,
            0,
          ]),
        );
        const bindGroup = this.#device.createBindGroup({
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
    } finally {
      pass.end();
      this.#device.queue.submit([encoder.finish()]);
      void this.#device.queue
        .onSubmittedWorkDone()
        .then(() => transientBuffers.forEach((buffer) => buffer.destroy()));
      for (const layer of layers) layer.frame.close();
      this.#submittedFrames += 1;
      this.#lastSubmitCpuMs = performance.now() - started;
    }
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
    this.#context?.unconfigure();
    this.#device?.destroy();
    this.#context = null;
    this.#device = null;
    this.#pipeline = null;
    this.#sampler = null;
    this.#format = null;
  }
}
