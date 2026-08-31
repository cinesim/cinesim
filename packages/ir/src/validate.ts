import type { IrEffect, IrProgram, IrSceneNode, IrValue } from "./types";

function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be non-negative integer microseconds.`);
}

export function validateIrProgram(program: IrProgram, assetIds?: ReadonlySet<string>): void {
  if (program.version !== 2 || program.languageVersion !== 1)
    throw new Error("Unsupported IR version.");
  const ids = new Set<string>();
  const claim = (id: string, kind: string): void => {
    if (!id) throw new Error(`${kind} requires a stable id.`);
    if (ids.has(id)) throw new Error(`Duplicate semantic id: ${id}`);
    ids.add(id);
  };
  const compositionIds = new Set(program.compositions.map((composition) => composition.id));
  if (!compositionIds.has(program.activeCompositionId)) {
    throw new Error(`Active composition not found: ${program.activeCompositionId}`);
  }
  const referenced = new Set<string>();
  const referenceValue = (value: IrValue): void => {
    if (value.kind !== "resource") return;
    referenced.add(value.assetId);
    if (assetIds !== undefined && !assetIds.has(value.assetId))
      throw new Error(`Unknown asset id: ${value.assetId}`);
  };
  const visitEffect = (effect: IrEffect): void => {
    claim(effect.id, "effect");
    Object.values(effect.props).forEach(referenceValue);
    effect.children.forEach(visitScene);
  };
  function visitScene(node: IrSceneNode): void {
    claim(node.id, node.kind);
    Object.values(node.props).forEach(referenceValue);
    for (const animation of node.animations) {
      for (const keyframe of animation.keyframes) {
        assertTime(keyframe.at, `${node.id}.${animation.property}.keyframe`);
        referenceValue(keyframe.value);
      }
    }
    node.effects.forEach(visitEffect);
    node.children.forEach(visitScene);
  }
  for (const composition of program.compositions) {
    claim(composition.id, "composition");
    claim(composition.timeline.id, "timeline");
    if (!Number.isInteger(composition.width) || composition.width <= 0)
      throw new Error("Composition width must be a positive integer.");
    if (!Number.isInteger(composition.height) || composition.height <= 0)
      throw new Error("Composition height must be a positive integer.");
    if (!Number.isFinite(composition.frameRate) || composition.frameRate <= 0)
      throw new Error("Composition frame rate must be positive.");
    const clips = new Map<
      string,
      {
        trackId: string;
        assetId?: string;
        linkedClipId?: string;
        start: number;
        duration: number;
        source: number;
      }
    >();
    for (const track of composition.timeline.tracks) {
      claim(track.id, "track");
      for (const clip of track.clips) {
        claim(clip.id, "clip");
        if (clip.trackId !== track.id) throw new Error(`Clip ${clip.id} has the wrong trackId.`);
        assertTime(clip.timelineStartUs, `${clip.id}.timelineStartUs`);
        assertTime(clip.sourceStartUs, `${clip.id}.sourceStartUs`);
        assertTime(clip.durationUs, `${clip.id}.durationUs`);
        assertTime(clip.fades.inUs, `${clip.id}.fadeInUs`);
        assertTime(clip.fades.outUs, `${clip.id}.fadeOutUs`);
        if (clip.durationUs <= 0) throw new Error(`Clip ${clip.id} duration must be positive.`);
        if (clip.fades.inUs + clip.fades.outUs > clip.durationUs)
          throw new Error(`Clip ${clip.id} fades exceed its duration.`);
        if (clip.assetId !== undefined) {
          referenceValue({ kind: "resource", assetId: clip.assetId });
        }
        if (clip.content) visitScene(clip.content);
        clip.effects.forEach(visitEffect);
        clips.set(clip.id, {
          trackId: track.id,
          ...(clip.assetId === undefined ? {} : { assetId: clip.assetId }),
          ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId }),
          start: clip.timelineStartUs,
          duration: clip.durationUs,
          source: clip.sourceStartUs,
        });
      }
      track.effects.forEach(visitEffect);
    }
    for (const [id, clip] of clips) {
      if (!clip.linkedClipId) continue;
      const linked = clips.get(clip.linkedClipId);
      if (
        !linked ||
        linked.linkedClipId !== id ||
        linked.assetId !== clip.assetId ||
        linked.start !== clip.start ||
        linked.duration !== clip.duration ||
        linked.source !== clip.source
      ) {
        throw new Error(`Clip link is not reciprocal and range-equivalent: ${id}`);
      }
    }
    for (const marker of composition.timeline.markers) {
      claim(marker.id, "marker");
      assertTime(marker.atUs, `${marker.id}.atUs`);
    }
    for (const transition of composition.timeline.transitions) {
      claim(transition.id, "transition");
      assertTime(transition.durationUs, `${transition.id}.durationUs`);
      if (!clips.has(transition.fromClipId) || !clips.has(transition.toClipId))
        throw new Error(`Transition ${transition.id} references a missing clip.`);
    }
  }
  const expected = [...referenced].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(program.referencedAssetIds) !== JSON.stringify(expected)) {
    throw new Error(
      "referencedAssetIds must be sorted and exactly match semantic asset references.",
    );
  }
}
