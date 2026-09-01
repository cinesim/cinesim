import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_TRANSFORM } from "../../core/test/project-fixtures";
import { WebGpuCompositor } from "../src";

const originalDescriptors = new Map(
  ["navigator", "window", "GPUShaderStage", "GPUBufferUsage", "GPUTextureUsage"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);

afterEach(() => {
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("WebGpuCompositor resource ownership", () => {
  it("captures a manually sized WebGPU output only after submitted work completes", async () => {
    let submittedWorkSettled = false;
    const pass = {
      setPipeline: () => undefined,
      setBindGroup: () => undefined,
      draw: () => undefined,
      end: () => undefined,
    };
    const device = {
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
      queue: {
        writeBuffer: () => undefined,
        submit: () => undefined,
        onSubmittedWorkDone: async () => {
          submittedWorkSettled = true;
        },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass,
        finish: () => ({}),
      }),
      createBuffer: () => ({ destroy: () => undefined }),
      createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
      createBindGroup: () => ({}),
      importExternalTexture: () => ({}),
      destroy: () => undefined,
    };
    const context = {
      configure: () => undefined,
      unconfigure: () => undefined,
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
    const canvas = {
      width: 1,
      height: 1,
      clientWidth: 0,
      clientHeight: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => {
        expect(submittedWorkSettled).toBe(true);
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
      },
    };
    Object.defineProperties(globalThis, {
      navigator: {
        configurable: true,
        value: {
          gpu: {
            requestAdapter: async () => ({ requestDevice: async () => device }),
            getPreferredCanvasFormat: () => "bgra8unorm",
          },
        },
      },
      window: { configurable: true, value: { devicePixelRatio: 1 } },
      GPUShaderStage: { configurable: true, value: { FRAGMENT: 1, VERTEX: 2 } },
      GPUBufferUsage: { configurable: true, value: { UNIFORM: 1, COPY_DST: 2 } },
      GPUTextureUsage: { configurable: true, value: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 } },
    });
    const compositor = new WebGpuCompositor(canvas as unknown as HTMLCanvasElement, {
      autoResize: false,
      textRendering: "disabled",
    });
    compositor.setOutputSize(1280, 720);
    await compositor.initialize();
    compositor.render([], { width: 1920, height: 1080 });

    await expect(compositor.capturePng()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(canvas).toMatchObject({ width: 1280, height: 720 });
    compositor.destroy();
  });

  for (const failurePoint of ["pass.end", "encoder.finish", "queue.submit"] as const) {
    it(`closes frames and destroys transient buffers when ${failurePoint} fails`, async () => {
      let frameCloses = 0;
      let bufferDestroys = 0;
      const reported: Error[] = [];
      const expected = new Error(`${failurePoint} failed`);
      const pass = {
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        draw: () => undefined,
        end: () => {
          if (failurePoint === "pass.end") throw expected;
        },
      };
      const encoder = {
        beginRenderPass: () => pass,
        finish: () => {
          if (failurePoint === "encoder.finish") throw expected;
          return {};
        },
      };
      const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => undefined),
        queue: {
          writeBuffer: () => undefined,
          submit: () => {
            if (failurePoint === "queue.submit") throw expected;
          },
          onSubmittedWorkDone: async () => undefined,
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        createSampler: () => ({}),
        createShaderModule: () => ({}),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
        createCommandEncoder: () => encoder,
        createBuffer: () => ({
          destroy: () => {
            bufferDestroys += 1;
          },
        }),
        createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
        createBindGroup: () => ({}),
        importExternalTexture: () => ({}),
        destroy: () => undefined,
      };
      const context = {
        configure: () => undefined,
        unconfigure: () => undefined,
        getCurrentTexture: () => ({ createView: () => ({}) }),
      };
      const canvas = {
        width: 1920,
        height: 1080,
        clientWidth: 1920,
        clientHeight: 1080,
        getContext: () => context,
      };
      Object.defineProperties(globalThis, {
        navigator: {
          configurable: true,
          value: {
            gpu: {
              requestAdapter: async () => ({ requestDevice: async () => device }),
              getPreferredCanvasFormat: () => "bgra8unorm",
            },
          },
        },
        window: { configurable: true, value: { devicePixelRatio: 1 } },
        GPUShaderStage: { configurable: true, value: { FRAGMENT: 1, VERTEX: 2 } },
        GPUBufferUsage: { configurable: true, value: { UNIFORM: 1, COPY_DST: 2 } },
        GPUTextureUsage: {
          configurable: true,
          value: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 },
        },
      });
      const compositor = new WebGpuCompositor(canvas as unknown as HTMLCanvasElement, {
        onError: (error) => reported.push(error),
        textRendering: "disabled",
      });
      await compositor.initialize();

      compositor.render([
        {
          frame: {
            displayWidth: 1920,
            displayHeight: 1080,
            close: () => {
              frameCloses += 1;
            },
          } as VideoFrame,
          transform: DEFAULT_TRANSFORM,
        },
      ]);

      expect(frameCloses).toBe(1);
      expect(bufferDestroys).toBe(1);
      expect(reported).toEqual([expected]);
      expect(compositor.metrics.submittedFrames).toBe(0);
      compositor.destroy();
    });
  }
});
