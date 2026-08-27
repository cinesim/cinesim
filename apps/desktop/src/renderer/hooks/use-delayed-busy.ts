import { useEffect, useRef, useState } from "react";

interface DelayedBusyOptions {
  delayMs?: number;
  minimumVisibleMs?: number;
}

export function useDelayedBusy(
  busy: boolean,
  { delayMs = 150, minimumVisibleMs = 200 }: DelayedBusyOptions = {},
): boolean {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (busy) {
      if (!visibleRef.current) {
        timer = setTimeout(() => {
          visibleRef.current = true;
          shownAtRef.current = performance.now();
          setVisible(true);
        }, delayMs);
      }
    } else if (visibleRef.current) {
      const elapsed = performance.now() - (shownAtRef.current ?? performance.now());
      timer = setTimeout(
        () => {
          visibleRef.current = false;
          shownAtRef.current = null;
          setVisible(false);
        },
        Math.max(0, minimumVisibleMs - elapsed),
      );
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [busy, delayMs, minimumVisibleMs]);

  return visible;
}
