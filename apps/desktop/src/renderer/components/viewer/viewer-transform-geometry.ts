import type { Asset } from "@cinesim/core";
import type { IrTransform, IrValue } from "@cinesim/ir";

export type TransformGestureKind = "move" | "rotate" | "scale";

export interface ViewerPoint {
  x: number;
  y: number;
}

export interface ViewerTransformBox {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
}

export interface TransformGesture {
  kind: TransformGestureKind;
  start: IrTransform;
  startPointer: ViewerPoint;
  center: ViewerPoint;
  composition: { width: number; height: number };
  display: { width: number; height: number };
  startDistance: number;
  startAngle: number;
}

function pointerDistance(pointer: ViewerPoint, center: ViewerPoint): number {
  return Math.hypot(pointer.x - center.x, pointer.y - center.y);
}

function pointerAngle(pointer: ViewerPoint, center: ViewerPoint): number {
  return (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI;
}

function rounded(value: number, precision = 3): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function containedSize(
  asset: Pick<Asset, "width" | "height"> | null,
  transform: IrTransform,
  composition: { width: number; height: number },
): { x: number; y: number } {
  if (!asset?.width || !asset.height || transform.fit !== "contain") return { x: 1, y: 1 };
  const sourceAspect = asset.width / asset.height;
  const targetAspect =
    (Math.abs(transform.scaleX) * composition.width) /
    Math.max(0.000_1, Math.abs(transform.scaleY) * composition.height);
  return sourceAspect > targetAspect
    ? { x: 1, y: targetAspect / sourceAspect }
    : { x: sourceAspect / targetAspect, y: 1 };
}

export function viewerTransformBox(
  transform: IrTransform,
  composition: { width: number; height: number },
  display: { width: number; height: number },
  asset: Pick<Asset, "width" | "height"> | null,
): ViewerTransformBox {
  const fit = containedSize(asset, transform, composition);
  return {
    centerX: display.width / 2 + (transform.x / composition.width) * display.width,
    centerY: display.height / 2 + (transform.y / composition.height) * display.height,
    width: Math.max(1, display.width * Math.abs(transform.scaleX) * fit.x),
    height: Math.max(1, display.height * Math.abs(transform.scaleY) * fit.y),
    rotation: transform.rotation,
  };
}

export function beginTransformGesture(
  kind: TransformGestureKind,
  start: IrTransform,
  startPointer: ViewerPoint,
  center: ViewerPoint,
  composition: { width: number; height: number },
  display: { width: number; height: number },
): TransformGesture {
  return {
    kind,
    start: structuredClone(start),
    startPointer,
    center,
    composition,
    display,
    startDistance: Math.max(1, pointerDistance(startPointer, center)),
    startAngle: pointerAngle(startPointer, center),
  };
}

export function updateTransformGesture(
  gesture: TransformGesture,
  pointer: ViewerPoint,
): IrTransform {
  if (gesture.kind === "move") {
    return {
      ...gesture.start,
      x: rounded(
        gesture.start.x +
          ((pointer.x - gesture.startPointer.x) / gesture.display.width) *
            gesture.composition.width,
      ),
      y: rounded(
        gesture.start.y +
          ((pointer.y - gesture.startPointer.y) / gesture.display.height) *
            gesture.composition.height,
      ),
    };
  }
  if (gesture.kind === "scale") {
    const ratio = Math.max(0.01, pointerDistance(pointer, gesture.center) / gesture.startDistance);
    return {
      ...gesture.start,
      scaleX: rounded(gesture.start.scaleX * ratio),
      scaleY: rounded(gesture.start.scaleY * ratio),
    };
  }
  return {
    ...gesture.start,
    rotation: rounded(
      gesture.start.rotation + pointerAngle(pointer, gesture.center) - gesture.startAngle,
      1,
    ),
  };
}

export function transformGestureUpdates(
  kind: TransformGestureKind,
  transform: IrTransform,
): Array<{ property: string; value: IrValue }> {
  if (kind === "move") {
    return [
      { property: "x", value: { kind: "length", unit: "px", value: transform.x } },
      { property: "y", value: { kind: "length", unit: "px", value: transform.y } },
    ];
  }
  if (kind === "scale") {
    return [
      { property: "scaleX", value: { kind: "number", value: transform.scaleX } },
      { property: "scaleY", value: { kind: "number", value: transform.scaleY } },
    ];
  }
  return [
    {
      property: "rotation",
      value: { kind: "angle", unit: "deg", value: transform.rotation },
    },
  ];
}
