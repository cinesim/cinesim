import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@cinesim/ui";

type HeaderLocationMotion = "deeper" | "replace" | "shallower";

interface HeaderLocationFrame {
  content: ReactNode;
  depth: number;
  id: number;
}

export function headerLocationMotion(fromDepth: number, toDepth: number): HeaderLocationMotion {
  if (toDepth > fromDepth) return "deeper";
  if (toDepth < fromDepth) return "shallower";
  return "replace";
}

export function AnimatedHeaderLocation({
  transitionKey,
  depth,
  children,
}: {
  transitionKey: string;
  depth: number;
  children: ReactNode;
}) {
  const nextFrameId = useRef(1);
  const lastContent = useRef(children);
  const [current, setCurrent] = useState(() => ({ depth, key: transitionKey }));
  const [leaving, setLeaving] = useState<HeaderLocationFrame | null>(null);

  useLayoutEffect(() => {
    if (current.key !== transitionKey) {
      setLeaving({
        content: lastContent.current,
        depth: current.depth,
        id: nextFrameId.current++,
      });
      setCurrent({ depth, key: transitionKey });
    }
    lastContent.current = children;
  }, [children, current.depth, current.key, depth, transitionKey]);

  useEffect(() => {
    if (!leaving) return;
    const leavingId = leaving.id;
    const timeout = window.setTimeout(
      () => setLeaving((frame) => (frame?.id === leavingId ? null : frame)),
      180,
    );
    return () => window.clearTimeout(timeout);
  }, [leaving]);

  const motion = leaving ? headerLocationMotion(leaving.depth, current.depth) : null;

  return (
    <div className="grid min-w-0 place-items-center">
      {leaving && (
        <div
          key={`leaving:${leaving.id}`}
          className={cn(
            "pointer-events-none col-start-1 row-start-1",
            `header-location-exit-${motion}`,
          )}
          aria-hidden="true"
          inert
        >
          {leaving.content}
        </div>
      )}
      <div
        key={current.key}
        className={cn("col-start-1 row-start-1", motion && `header-location-enter-${motion}`)}
      >
        {children}
      </div>
    </div>
  );
}
