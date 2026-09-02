import type { IrClip, IrComposition, IrEffect, IrTimeUs, IrTrack, IrValue } from "./types";
import { irTimeUs } from "./types";

export interface IrGainAutomationPoint {
  timelineUs: IrTimeUs;
  gain: number;
}

function prop(effect: IrEffect, name: string): IrValue | undefined {
  return effect.props[name];
}

function stringProp(effect: IrEffect, name: string): string | undefined {
  const value = prop(effect, name);
  return value?.kind === "string" ? value.value : undefined;
}

function numberProp(effect: IrEffect, name: string, fallback: number): number {
  const value = prop(effect, name);
  return value?.kind === "number" || value?.kind === "decibels" ? value.value : fallback;
}

function timeProp(effect: IrEffect, name: string, fallback: number): number {
  const value = prop(effect, name);
  return value?.kind === "time" ? value.valueUs : fallback;
}

function activeDuckerEffects(track: IrTrack, clip: IrClip): IrEffect[] {
  return [...track.effects, ...clip.effects].filter(
    (effect) => effect.enabled && effect.kind === "ducker",
  );
}

function audibleSidechain(track: IrTrack | undefined): IrTrack | undefined {
  return track?.kind === "audio" && !track.muted ? track : undefined;
}

function intervalDuckGain(
  atUs: number,
  startUs: number,
  endUs: number,
  attackUs: number,
  releaseUs: number,
  reducedGain: number,
): number {
  if (atUs >= startUs && atUs <= endUs) return reducedGain;
  if (attackUs > 0 && atUs >= startUs - attackUs && atUs < startUs) {
    return 1 + (reducedGain - 1) * ((atUs - (startUs - attackUs)) / attackUs);
  }
  if (releaseUs > 0 && atUs > endUs && atUs <= endUs + releaseUs) {
    return reducedGain + (1 - reducedGain) * ((atUs - endUs) / releaseUs);
  }
  return 1;
}

function duckerGainAt(composition: IrComposition, effect: IrEffect, atUs: number): number {
  const sidechainId = stringProp(effect, "sidechain");
  const sidechain = audibleSidechain(
    composition.timeline.tracks.find((track) => track.id === sidechainId),
  );
  if (!sidechain) return 1;
  const attackUs = Math.max(0, timeProp(effect, "attack", 80_000));
  const releaseUs = Math.max(0, timeProp(effect, "release", 250_000));
  const reducedGain = 10 ** (Math.min(0, numberProp(effect, "reduction", -12)) / 20);
  return sidechain.clips.reduce((gain, clip) => {
    if (!clip.enabled || clip.audio.muted) return gain;
    const intervalGain = intervalDuckGain(
      atUs,
      clip.timelineStartUs,
      clip.timelineStartUs + clip.durationUs,
      attackUs,
      releaseUs,
      reducedGain,
    );
    return Math.min(gain, intervalGain);
  }, 1);
}

export function audioDuckGainAt(
  composition: IrComposition,
  track: IrTrack,
  clip: IrClip,
  atUs: number,
): number {
  return activeDuckerEffects(track, clip).reduce(
    (gain, effect) => gain * duckerGainAt(composition, effect, atUs),
    1,
  );
}

function effectBreakpoints(composition: IrComposition, effect: IrEffect): number[] {
  const sidechainId = stringProp(effect, "sidechain");
  const sidechain = audibleSidechain(
    composition.timeline.tracks.find((track) => track.id === sidechainId),
  );
  if (!sidechain) return [];
  const attackUs = Math.max(0, timeProp(effect, "attack", 80_000));
  const releaseUs = Math.max(0, timeProp(effect, "release", 250_000));
  return sidechain.clips.flatMap((clip) => {
    if (!clip.enabled || clip.audio.muted) return [];
    const endUs = clip.timelineStartUs + clip.durationUs;
    return [clip.timelineStartUs - attackUs, clip.timelineStartUs, endUs, endUs + releaseUs];
  });
}

export function audioDuckAutomation(
  composition: IrComposition,
  track: IrTrack,
  clip: IrClip,
  fromUs: number,
  toUs: number,
): IrGainAutomationPoint[] {
  const effects = activeDuckerEffects(track, clip);
  if (effects.length === 0) return [];
  const times = new Set([
    fromUs,
    toUs,
    ...effects.flatMap((effect) => effectBreakpoints(composition, effect)),
  ]);
  return [...times]
    .filter((atUs) => atUs >= fromUs && atUs <= toUs)
    .sort((left, right) => left - right)
    .map((atUs) => ({
      timelineUs: irTimeUs(atUs),
      gain: audioDuckGainAt(composition, track, clip, atUs),
    }));
}
