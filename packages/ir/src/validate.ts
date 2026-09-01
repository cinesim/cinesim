import type {
  IrClip,
  IrComposition,
  IrEffect,
  IrProgram,
  IrSceneNode,
  IrTimeline,
  IrTrack,
  IrValue,
} from "./types";

interface ClipLinkRecord {
  trackId: string;
  assetId?: string;
  linkedClipId?: string;
  start: number;
  duration: number;
  source: number;
}

function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be non-negative integer microseconds.`);
  }
}

class ProgramValidator {
  readonly #ids = new Set<string>();
  readonly #referencedAssets = new Set<string>();

  constructor(private readonly assetIds?: ReadonlySet<string>) {}

  claim(id: string, kind: string): void {
    if (!id) throw new Error(`${kind} requires a stable id.`);
    if (this.#ids.has(id)) throw new Error(`Duplicate semantic id: ${id}`);
    this.#ids.add(id);
  }

  referenceValue(value: IrValue): void {
    if (value.kind !== "resource") return;
    this.#referencedAssets.add(value.assetId);
    if (this.assetIds !== undefined && !this.assetIds.has(value.assetId)) {
      throw new Error(`Unknown asset id: ${value.assetId}`);
    }
  }

  visitEffect(effect: IrEffect): void {
    this.claim(effect.id, "effect");
    Object.values(effect.props).forEach((value) => this.referenceValue(value));
    effect.children.forEach((child) => this.visitScene(child));
  }

  visitScene(node: IrSceneNode): void {
    this.claim(node.id, node.kind);
    Object.values(node.props).forEach((value) => this.referenceValue(value));
    for (const animation of node.animations) {
      for (const keyframe of animation.keyframes) {
        assertTime(keyframe.at, `${node.id}.${animation.property}.keyframe`);
        this.referenceValue(keyframe.value);
      }
    }
    node.effects.forEach((effect) => this.visitEffect(effect));
    node.children.forEach((child) => this.visitScene(child));
  }

  validateClip(clip: IrClip, track: IrTrack): ClipLinkRecord {
    this.claim(clip.id, "clip");
    if (clip.trackId !== track.id) throw new Error(`Clip ${clip.id} has the wrong trackId.`);
    assertTime(clip.timelineStartUs, `${clip.id}.timelineStartUs`);
    assertTime(clip.sourceStartUs, `${clip.id}.sourceStartUs`);
    assertTime(clip.durationUs, `${clip.id}.durationUs`);
    assertTime(clip.fades.inUs, `${clip.id}.fadeInUs`);
    assertTime(clip.fades.outUs, `${clip.id}.fadeOutUs`);
    if (clip.durationUs <= 0) throw new Error(`Clip ${clip.id} duration must be positive.`);
    if (clip.fades.inUs + clip.fades.outUs > clip.durationUs) {
      throw new Error(`Clip ${clip.id} fades exceed its duration.`);
    }
    if (clip.assetId !== undefined) {
      this.referenceValue({ kind: "resource", assetId: clip.assetId });
    }
    if (clip.content) this.visitScene(clip.content);
    clip.effects.forEach((effect) => this.visitEffect(effect));
    return {
      trackId: track.id,
      ...(clip.assetId === undefined ? {} : { assetId: clip.assetId }),
      ...(clip.linkedClipId === undefined ? {} : { linkedClipId: clip.linkedClipId }),
      start: clip.timelineStartUs,
      duration: clip.durationUs,
      source: clip.sourceStartUs,
    };
  }

  validateTrack(track: IrTrack, clips: Map<string, ClipLinkRecord>): void {
    this.claim(track.id, "track");
    for (const clip of track.clips) clips.set(clip.id, this.validateClip(clip, track));
    track.effects.forEach((effect) => this.visitEffect(effect));
  }

  validateClipLinks(clips: ReadonlyMap<string, ClipLinkRecord>): void {
    for (const [id, clip] of clips) {
      if (!clip.linkedClipId) continue;
      const linked = clips.get(clip.linkedClipId);
      const reciprocalAndEquivalent =
        linked?.linkedClipId === id &&
        linked.assetId === clip.assetId &&
        linked.start === clip.start &&
        linked.duration === clip.duration &&
        linked.source === clip.source;
      if (!reciprocalAndEquivalent) {
        throw new Error(`Clip link is not reciprocal and range-equivalent: ${id}`);
      }
    }
  }

  validateComposition(composition: IrComposition): void {
    this.claim(composition.id, "composition");
    this.claim(composition.timeline.id, "timeline");
    if (!Number.isInteger(composition.width) || composition.width <= 0) {
      throw new Error("Composition width must be a positive integer.");
    }
    if (!Number.isInteger(composition.height) || composition.height <= 0) {
      throw new Error("Composition height must be a positive integer.");
    }
    if (!Number.isFinite(composition.frameRate) || composition.frameRate <= 0) {
      throw new Error("Composition frame rate must be positive.");
    }
    const clips = new Map<string, ClipLinkRecord>();
    for (const track of composition.timeline.tracks) this.validateTrack(track, clips);
    this.validateClipLinks(clips);
    this.validateEditorialMetadata(composition.timeline, clips);
  }

  validateEditorialMetadata(
    timeline: IrTimeline,
    clips: ReadonlyMap<string, ClipLinkRecord>,
  ): void {
    for (const note of timeline.notes) {
      this.claim(note.id, "note");
      assertTime(note.atUs, `${note.id}.atUs`);
      if (note.durationUs !== undefined) assertTime(note.durationUs, `${note.id}.durationUs`);
      if (!note.text.trim()) throw new Error(`Timeline note ${note.id} must contain text.`);
    }
    for (const marker of timeline.markers) {
      this.claim(marker.id, "marker");
      assertTime(marker.atUs, `${marker.id}.atUs`);
    }
    for (const transition of timeline.transitions) {
      this.claim(transition.id, "transition");
      assertTime(transition.durationUs, `${transition.id}.durationUs`);
      if (!clips.has(transition.fromClipId) || !clips.has(transition.toClipId)) {
        throw new Error(`Transition ${transition.id} references a missing clip.`);
      }
    }
  }

  validate(program: IrProgram): void {
    if (program.version !== 2 || program.languageVersion !== 1) {
      throw new Error("Unsupported IR version.");
    }
    const compositionIds = new Set(program.compositions.map((composition) => composition.id));
    if (!compositionIds.has(program.activeCompositionId)) {
      throw new Error(`Active composition not found: ${program.activeCompositionId}`);
    }
    program.compositions.forEach((composition) => this.validateComposition(composition));
    const expected = [...this.#referencedAssets].sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(program.referencedAssetIds) !== JSON.stringify(expected)) {
      throw new Error(
        "referencedAssetIds must be sorted and exactly match semantic asset references.",
      );
    }
  }
}

export function validateIrProgram(program: IrProgram, assetIds?: ReadonlySet<string>): void {
  new ProgramValidator(assetIds).validate(program);
}
