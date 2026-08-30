import { useEffect, useState } from "react";
import type { RefObject } from "react";

export interface ElementBounds {
  width: number;
  height: number;
}

export function useElementBounds<T extends HTMLElement>(ref: RefObject<T | null>): ElementBounds {
  const [bounds, setBounds] = useState<ElementBounds>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setBounds((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return bounds;
}
