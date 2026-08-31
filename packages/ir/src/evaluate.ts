import { irTimeUs } from "./types";
import type { EvaluatedIrNode, IrAnimation, IrSceneNode, IrValue } from "./types";

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolate(from: IrValue, to: IrValue, progress: number): IrValue {
  if (from.kind !== to.kind) return progress < 1 ? from : to;
  if (from.kind === "number" && to.kind === "number") {
    return { kind: "number", value: interpolateNumber(from.value, to.value, progress) };
  }
  if (from.kind === "length" && to.kind === "length") {
    return { kind: "length", unit: "px", value: interpolateNumber(from.value, to.value, progress) };
  }
  if (from.kind === "angle" && to.kind === "angle") {
    return { kind: "angle", unit: "deg", value: interpolateNumber(from.value, to.value, progress) };
  }
  if (from.kind === "decibels" && to.kind === "decibels") {
    return { kind: "decibels", value: interpolateNumber(from.value, to.value, progress) };
  }
  if (from.kind === "percent" && to.kind === "percent") {
    return { kind: "percent", value: interpolateNumber(from.value, to.value, progress) };
  }
  if (from.kind === "time" && to.kind === "time") {
    return {
      kind: "time",
      valueUs: irTimeUs(Math.round(interpolateNumber(from.valueUs, to.valueUs, progress))),
    };
  }
  if (from.kind === "vector" && to.kind === "vector") {
    return {
      kind: "vector",
      values: [
        interpolateNumber(from.values[0], to.values[0], progress),
        interpolateNumber(from.values[1], to.values[1], progress),
      ],
    };
  }
  if (from.kind === "rectangle" && to.kind === "rectangle") {
    return {
      kind: "rectangle",
      values: from.values.map((value, index) =>
        interpolateNumber(value, to.values[index]!, progress),
      ) as [number, number, number, number],
    };
  }
  return progress < 1 ? from : to;
}

function applyEasing(progress: number, easing: string): number {
  if (easing === "hold") return progress < 1 ? 0 : 1;
  if (easing === "ease-in") return progress * progress;
  if (easing === "ease-out") return 1 - (1 - progress) * (1 - progress);
  if (easing === "ease-in-out") {
    return progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
  }
  return progress;
}

function evaluateAnimation(animation: IrAnimation, timeUs: number): IrValue | undefined {
  const [first] = animation.keyframes;
  if (first === undefined) return undefined;
  if (timeUs <= first.at) return first.value;
  for (let index = 1; index < animation.keyframes.length; index += 1) {
    const next = animation.keyframes[index]!;
    const previous = animation.keyframes[index - 1]!;
    if (timeUs <= next.at) {
      const duration = next.at - previous.at;
      const progress = duration === 0 ? 1 : (timeUs - previous.at) / duration;
      return interpolate(previous.value, next.value, applyEasing(progress, next.easing));
    }
  }
  return animation.keyframes.at(-1)!.value;
}

export function evaluateIrFrame(node: IrSceneNode, localTimeUs: number): EvaluatedIrNode {
  if (!Number.isSafeInteger(localTimeUs) || localTimeUs < 0) {
    throw new Error("Frame time must be a non-negative integer number of microseconds.");
  }
  const props = { ...node.props };
  for (const animation of node.animations) {
    const value = evaluateAnimation(animation, localTimeUs);
    if (value !== undefined) props[animation.property] = value;
  }
  return {
    id: node.id,
    kind: node.kind,
    props,
    effects: node.effects,
    children: node.children.map((child) => evaluateIrFrame(child, localTimeUs)),
  };
}
