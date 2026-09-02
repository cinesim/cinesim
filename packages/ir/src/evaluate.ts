import { irTimeUs } from "./types";
import type { EvaluatedIrNode, IrAnimation, IrEffect, IrSceneNode, IrValue } from "./types";

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolate(from: IrValue, to: IrValue, progress: number): IrValue {
  if (from.kind !== to.kind) return progress < 1 ? from : to;
  switch (from.kind) {
    case "number":
    case "decibels":
    case "percent":
      return {
        ...from,
        value: interpolateNumber(from.value, (to as { value: number }).value, progress),
      };
    case "length":
    case "angle":
      return {
        ...from,
        value: interpolateNumber(from.value, (to as { value: number }).value, progress),
      };
    case "time":
      return {
        kind: "time",
        valueUs: irTimeUs(
          Math.round(
            interpolateNumber(
              from.valueUs,
              (to as Extract<IrValue, { kind: "time" }>).valueUs,
              progress,
            ),
          ),
        ),
      };
    case "vector":
      return {
        kind: "vector",
        values: from.values.map((value, index) =>
          interpolateNumber(
            value,
            (to as Extract<IrValue, { kind: "vector" }>).values[index]!,
            progress,
          ),
        ) as [number, number],
      };
    case "rectangle":
      return {
        kind: "rectangle",
        values: from.values.map((value, index) =>
          interpolateNumber(
            value,
            (to as Extract<IrValue, { kind: "rectangle" }>).values[index]!,
            progress,
          ),
        ) as [number, number, number, number],
      };
    default:
      return progress < 1 ? from : to;
  }
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

export function evaluateAnimation(animation: IrAnimation, timeUs: number): IrValue | undefined {
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

export function evaluateIrEffects(effects: readonly IrEffect[], localTimeUs: number): IrEffect[] {
  return effects.map((effect) => {
    const props = { ...effect.props };
    for (const animation of effect.animations ?? []) {
      const value = evaluateAnimation(animation, localTimeUs);
      if (value !== undefined) props[animation.property] = value;
    }
    return {
      ...effect,
      props,
      children: effect.children,
    };
  });
}

function evaluatedSceneNode(node: IrSceneNode, localTimeUs: number): EvaluatedIrNode {
  const props = { ...node.props };
  for (const animation of node.animations) {
    const value = evaluateAnimation(animation, localTimeUs);
    if (value !== undefined) props[animation.property] = value;
  }
  return {
    id: node.id,
    kind: node.kind,
    props,
    effects: evaluateIrEffects(node.effects, localTimeUs),
    children: node.children.map((child) => evaluatedSceneNode(child, localTimeUs)),
  };
}

export function evaluateIrFrame(node: IrSceneNode, localTimeUs: number): EvaluatedIrNode {
  if (!Number.isSafeInteger(localTimeUs) || localTimeUs < 0) {
    throw new Error("Frame time must be a non-negative integer number of microseconds.");
  }
  return evaluatedSceneNode(node, localTimeUs);
}
