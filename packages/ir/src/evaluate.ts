import type { EvaluatedIrNode, IrAnimation, IrDocument, IrNode, IrValue } from "./types";

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolate(from: IrValue, to: IrValue, progress: number): IrValue {
  if (from.kind !== to.kind) return progress < 1 ? from : to;
  if (from.kind === "number" && to.kind === "number") {
    return { kind: "number", value: interpolateNumber(from.value, to.value, progress) };
  }
  if (from.kind === "length" && to.kind === "length") {
    return {
      kind: "length",
      unit: "px",
      value: interpolateNumber(from.value, to.value, progress),
    };
  }
  if (from.kind === "time" && to.kind === "time") {
    return {
      kind: "time",
      valueUs: Math.round(interpolateNumber(from.valueUs, to.valueUs, progress)),
    };
  }
  if (from.kind === "vector" && to.kind === "vector" && from.values.length === to.values.length) {
    return {
      kind: "vector",
      values: from.values.map((value, index) => interpolate(value, to.values[index]!, progress)),
    };
  }
  return progress < 1 ? from : to;
}

function applyEasing(progress: number, easing: string): number {
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
  if (timeUs <= first.at.valueUs) return first.value;

  for (let index = 1; index < animation.keyframes.length; index += 1) {
    const next = animation.keyframes[index]!;
    const previous = animation.keyframes[index - 1]!;
    if (timeUs <= next.at.valueUs) {
      const duration = next.at.valueUs - previous.at.valueUs;
      const progress = duration === 0 ? 1 : (timeUs - previous.at.valueUs) / duration;
      return interpolate(previous.value, next.value, applyEasing(progress, next.easing));
    }
  }

  return animation.keyframes.at(-1)!.value;
}

function evaluateNode(node: IrNode, timeUs: number): EvaluatedIrNode {
  const props = Object.fromEntries(
    Object.entries(node.props).map(([name, property]) => [name, property.value]),
  );
  for (const animation of node.animations) {
    const value = evaluateAnimation(animation, timeUs);
    if (value !== undefined) props[animation.property] = value;
  }
  return {
    id: node.id,
    kind: node.kind,
    props,
    children: node.children.map((child) => evaluateNode(child, timeUs)),
  };
}

export function evaluateIrFrame(document: IrDocument, timeUs: number): EvaluatedIrNode {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new Error("Frame time must be a non-negative integer number of microseconds.");
  }
  return evaluateNode(document.root, timeUs);
}
