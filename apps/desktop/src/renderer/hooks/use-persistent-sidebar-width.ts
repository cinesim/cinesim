import { useEffect, useRef, useState } from "react";

export interface PersistentSidebarWidthOptions {
  storageKey: string;
  minimum: number;
  maximum: () => number;
  defaultWidth: number;
  direction: 1 | -1;
}

export function clampSidebarWidth(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(minimum, maximum), Math.max(minimum, value));
}

export function readPersistentSidebarWidth(
  stored: string | null,
  minimum: number,
  maximum: number,
  defaultWidth: number,
): number {
  if (stored === null) return clampSidebarWidth(defaultWidth, minimum, maximum);
  const parsed = Number(stored);
  return Number.isFinite(parsed)
    ? clampSidebarWidth(parsed, minimum, maximum)
    : clampSidebarWidth(defaultWidth, minimum, maximum);
}

export function usePersistentSidebarWidth(options: PersistentSidebarWidthOptions) {
  const [width, setWidth] = useState(() =>
    readPersistentSidebarWidth(
      localStorage.getItem(options.storageKey),
      options.minimum,
      options.maximum(),
      options.defaultWidth,
    ),
  );
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  const originRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    const reconcile = () => {
      const next = clampSidebarWidth(widthRef.current, options.minimum, options.maximum());
      widthRef.current = next;
      setWidth(next);
    };
    window.addEventListener("resize", reconcile);
    return () => window.removeEventListener("resize", reconcile);
  }, [options]);

  function start(event: React.PointerEvent<HTMLDivElement>): void {
    if (originRef.current) return;
    originRef.current = { pointerId: event.pointerId, x: event.clientX, width: widthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }

  function move(event: React.PointerEvent<HTMLDivElement>): void {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const next = clampSidebarWidth(
      origin.width + options.direction * (event.clientX - origin.x),
      options.minimum,
      options.maximum(),
    );
    widthRef.current = next;
    setWidth(next);
  }

  function finish(event: React.PointerEvent<HTMLDivElement>): void {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    originRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem(options.storageKey, String(widthRef.current));
    setResizing(false);
  }

  function cancel(event: React.PointerEvent<HTMLDivElement>): void {
    const origin = originRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    originRef.current = null;
    widthRef.current = origin.width;
    setWidth(origin.width);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
  }

  return {
    width,
    resizing,
    resizeHandleProps: {
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: finish,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    },
  };
}
