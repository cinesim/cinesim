import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { RotateCcw } from "@cinesim/ui";
import type { Asset } from "@cinesim/core";
import type { IrComposition, IrTransform } from "@cinesim/ir";
import {
  beginTransformGesture,
  updateTransformGesture,
  viewerTransformBox,
  type TransformGesture,
  type TransformGestureKind,
} from "./viewer-transform-geometry";

interface ViewerTransformOverlayProps {
  asset: Asset | null;
  composition: IrComposition;
  disabled: boolean;
  displaySize: { width: number; height: number };
  frameRef: RefObject<HTMLDivElement | null>;
  transform: IrTransform;
  onCancel: () => void;
  onCommit: (kind: TransformGestureKind, transform: IrTransform) => void;
  onPreview: (transform: IrTransform) => void;
}

const SCALE_HANDLES = [
  { label: "Scale from top left", className: "-left-1.5 -top-1.5 cursor-nwse-resize" },
  { label: "Scale from top right", className: "-right-1.5 -top-1.5 cursor-nesw-resize" },
  { label: "Scale from bottom left", className: "-bottom-1.5 -left-1.5 cursor-nesw-resize" },
  { label: "Scale from bottom right", className: "-bottom-1.5 -right-1.5 cursor-nwse-resize" },
] as const;

export function ViewerTransformOverlay({
  asset,
  composition,
  disabled,
  displaySize,
  frameRef,
  transform,
  onCancel,
  onCommit,
  onPreview,
}: ViewerTransformOverlayProps) {
  const gestureRef = useRef<TransformGesture | null>(null);
  const box = viewerTransformBox(transform, composition, displaySize, asset);

  const startGesture = (kind: TransformGestureKind, event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame) return;
    gestureRef.current = beginTransformGesture(
      kind,
      transform,
      { x: event.clientX, y: event.clientY },
      { x: frame.left + box.centerX, y: frame.top + box.centerY },
      composition,
      displaySize,
    );
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const updateGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return null;
    const next = updateTransformGesture(gesture, { x: event.clientX, y: event.clientY });
    onPreview(next);
    return next;
  };

  const finishGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const next = updateGesture(event);
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (next) onCommit(gesture.kind, next);
  };

  const cancelGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    onCancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const gestureProps = (kind: TransformGestureKind) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startGesture(kind, event),
    onPointerMove: updateGesture,
    onPointerUp: finishGesture,
    onPointerCancel: cancelGesture,
  });

  return (
    <div
      className={`pointer-events-none absolute z-30 border border-accent shadow-[0_0_0_1px_rgb(0_0_0/0.7)] ${disabled ? "opacity-60" : ""}`}
      style={{
        left: box.centerX,
        top: box.centerY,
        width: box.width,
        height: box.height,
        transform: `translate(-50%, -50%) rotate(${box.rotation}deg)`,
      }}
      aria-label="Selected clip transform controls"
    >
      <button
        type="button"
        aria-label="Move clip"
        className="pointer-events-auto absolute inset-0 cursor-move bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait"
        disabled={disabled}
        {...gestureProps("move")}
      />
      {SCALE_HANDLES.map((handle) => (
        <button
          key={handle.label}
          type="button"
          aria-label={handle.label}
          className={`pointer-events-auto absolute z-10 size-3 rounded-sm border border-white bg-accent shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${handle.className}`}
          disabled={disabled}
          {...gestureProps("scale")}
        />
      ))}
      <div className="pointer-events-none absolute left-1/2 top-0 h-6 w-px -translate-x-1/2 -translate-y-full bg-accent" />
      <button
        type="button"
        aria-label="Rotate clip"
        className="pointer-events-auto absolute left-1/2 top-0 z-10 grid size-5 -translate-x-1/2 -translate-y-9 place-items-center rounded-full border border-white bg-accent text-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
        disabled={disabled}
        {...gestureProps("rotate")}
      >
        <RotateCcw size={11} />
      </button>
    </div>
  );
}
