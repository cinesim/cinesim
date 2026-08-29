import { timeUs } from "@cinesim/core";
import { MediabunnyWebCodecsSource, WebGpuCompositor } from "@cinesim/engine";

interface MemoryInfo {
  usedJSHeapSize: number;
}

interface ValidationPerformance extends Performance {
  memory?: MemoryInfo;
}

interface ValidationWindow extends Window {
  gc?: () => void;
}

interface FixtureResult {
  fixture: string;
  durationUs: number;
  decodedFrames: number;
  audioBuffers: number;
}

function requiredResultElement(): HTMLPreElement {
  const element = document.querySelector<HTMLPreElement>("#result");
  if (!element) throw new Error("Validation result element is missing");
  return element;
}

const resultElement = requiredResultElement();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function validateFixture(fixture: string): Promise<FixtureResult> {
  const source = new MediabunnyWebCodecsSource(`/fixtures/${fixture}`);
  let decodedFrames = 0;
  let audioBuffers = 0;
  try {
    const metadata = await source.prepare();
    assert(metadata.durationUs >= 1_900_000, `${fixture}: duration is shorter than expected`);
    assert(metadata.width === 320 && metadata.height === 180, `${fixture}: dimensions changed`);
    assert(metadata.hasAudio, `${fixture}: audio track was not decoded`);

    for (let index = 0; index < 48; index += 1) {
      const atUs = timeUs((index * 37_000) % 1_800_000);
      await source.seek(atUs);
      const frame = await source.getFrame(atUs);
      assert(frame, `${fixture}: seek ${index} returned no frame`);
      assert(
        frame.displayWidth === 320 && frame.displayHeight === 180,
        `${fixture}: frame changed size`,
      );
      frame.close();
      decodedFrames += 1;
    }

    for await (const chunk of source.buffers(timeUs(0), timeUs(500_000))) {
      assert(chunk.buffer.numberOfChannels > 0, `${fixture}: empty audio buffer`);
      audioBuffers += 1;
      if (audioBuffers >= 8) break;
    }
    assert(audioBuffers > 0, `${fixture}: no audio buffers were decoded`);

    return { fixture, durationUs: metadata.durationUs, decodedFrames, audioBuffers };
  } finally {
    source.destroy();
  }
}

async function validateWebGpu(): Promise<number> {
  assert(navigator.gpu, "WebGPU is unavailable");
  const canvas = document.createElement("canvas");
  canvas.style.width = "320px";
  canvas.style.height = "180px";
  document.body.append(canvas);
  const errors: Error[] = [];
  const compositor = new WebGpuCompositor(canvas, { onError: (error) => errors.push(error) });
  const source = new MediabunnyWebCodecsSource("/fixtures/h264-aac.mp4");
  try {
    await compositor.initialize();
    await source.prepare();
    for (let index = 0; index < 24; index += 1) {
      const atUs = timeUs(index * 70_000);
      const frame = await source.getFrame(atUs);
      assert(frame, `WebGPU frame ${index} was unavailable`);
      compositor.render(
        [
          {
            frame,
            transform: {
              x: 0,
              y: 0,
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              fit: "contain",
            },
          },
        ],
        { width: 320, height: 180 },
      );
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    assert(errors.length === 0, errors.map((error) => error.message).join("; "));
    assert(compositor.metrics.submittedFrames === 24, "WebGPU did not submit every decoded frame");
    assert(compositor.metrics.activeFrames === 0, "WebGPU retained active frames after submission");
    return compositor.metrics.submittedFrames;
  } finally {
    source.destroy();
    compositor.destroy();
    canvas.remove();
  }
}

async function run(): Promise<void> {
  const validationWindow = window as ValidationWindow;
  const validationPerformance = performance as ValidationPerformance;
  validationWindow.gc?.();
  const heapBefore = validationPerformance.memory?.usedJSHeapSize;
  const fixtures = await Promise.all([
    validateFixture("h264-aac.mp4"),
    validateFixture("vp9-opus.webm"),
  ]);
  const gpuSubmissions = await validateWebGpu();
  validationWindow.gc?.();
  const heapAfter = validationPerformance.memory?.usedJSHeapSize;
  const heapGrowthBytes =
    heapBefore === undefined || heapAfter === undefined
      ? null
      : Math.max(0, heapAfter - heapBefore);
  if (heapGrowthBytes !== null)
    assert(heapGrowthBytes <= 32 * 1024 * 1024, `JS heap grew by ${heapGrowthBytes} bytes`);

  resultElement.dataset.status = "passed";
  resultElement.textContent = JSON.stringify({ fixtures, gpuSubmissions, heapGrowthBytes });
}

void run().catch((error: unknown) => {
  resultElement.dataset.status = "failed";
  resultElement.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
});
