import type { Project } from "@cinesim/core";
import { PlaybackRuntime, WebGpuCompositor } from "@cinesim/engine";
import type { IrProgram } from "@cinesim/ir";
import type { DerivedProjectScope, FrameRenderRequest } from "../../shared/contracts";
import { ProxySourceResolver } from "./proxy-source-resolver";

export interface TimelineFrameResult {
  frame: ArrayBuffer;
  renderedTimeUs: FrameRenderRequest["normalizedTimeUs"];
  width: number;
  height: number;
}

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Timeline frame canceled", "AbortError");
}

/** Renders one accepted timeline sample through the production WebGPU preview path. */
export async function renderTimelineFrame(input: {
  project: Project;
  program: IrProgram;
  projectScope: DerivedProjectScope;
  request: FrameRenderRequest;
  signal: AbortSignal;
}): Promise<TimelineFrameResult> {
  if (input.request.target.kind !== "timeline") throw new Error("Expected a timeline frame target");
  const canvas = document.createElement("canvas");
  const compositor = new WebGpuCompositor(canvas, { autoResize: false });
  compositor.setOutputSize(input.request.width, input.request.height);
  const playback = new PlaybackRuntime(
    {
      program: {
        ...input.program,
        activeCompositionId: input.request.target.sequenceId,
      },
      assets: input.project.assets,
    },
    compositor,
    {
      sourceResolver: new ProxySourceResolver(input.projectScope, () => null),
    },
  );
  try {
    assertNotCanceled(input.signal);
    await playback.initialize();
    assertNotCanceled(input.signal);
    await playback.seekTimeline(input.request.normalizedTimeUs);
    assertNotCanceled(input.signal);
    const frame = await compositor.capturePng();
    assertNotCanceled(input.signal);
    return {
      frame,
      renderedTimeUs: input.request.normalizedTimeUs,
      width: input.request.width,
      height: input.request.height,
    };
  } finally {
    playback.destroy();
    compositor.destroy();
  }
}
