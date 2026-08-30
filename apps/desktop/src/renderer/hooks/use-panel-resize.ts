import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, PointerEventHandler } from "react";

interface PointerDelta {
  x: number;
  y: number;
}

interface PanelResizeOptions<Target extends string, Value> {
  initialValue: Value;
  fit: (value: Value) => Value;
  move: (origin: Value, target: Target, delta: PointerDelta) => Value;
  preview: (value: Value) => void;
  commit: (value: Value) => void | Promise<unknown>;
}

export interface PanelResizeHandleProps {
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
}

export function usePanelResize<Target extends string, Value>(
  options: PanelResizeOptions<Target, Value>,
): { value: Value; handleProps: (target: Target) => PanelResizeHandleProps } {
  const [value, setValue] = useState(options.initialValue);
  const valueRef = useRef(options.initialValue);
  const originRef = useRef<{ target: Target; x: number; y: number; value: Value } | null>(null);

  function releasePointer(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleProps(target: Target): PanelResizeHandleProps {
    return {
      onPointerDown(event) {
        const current = options.fit(valueRef.current);
        valueRef.current = current;
        originRef.current = { target, x: event.clientX, y: event.clientY, value: current };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      onPointerMove(event) {
        const origin = originRef.current;
        if (!origin || origin.target !== target) return;
        const next = options.fit(
          options.move(origin.value, target, {
            x: event.clientX - origin.x,
            y: event.clientY - origin.y,
          }),
        );
        valueRef.current = next;
        options.preview(next);
      },
      onPointerUp(event) {
        if (originRef.current?.target !== target) return;
        originRef.current = null;
        releasePointer(event);
        setValue(valueRef.current);
        void options.commit(valueRef.current);
      },
      onPointerCancel(event) {
        const origin = originRef.current;
        if (!origin || origin.target !== target) return;
        originRef.current = null;
        releasePointer(event);
        valueRef.current = origin.value;
        options.preview(origin.value);
        setValue(origin.value);
      },
    };
  }

  return { value, handleProps };
}
