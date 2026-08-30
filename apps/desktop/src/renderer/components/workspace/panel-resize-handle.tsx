import { cn } from "@cinesim/ui";
import type { PanelResizeHandleProps as PanelResizeEvents } from "../../hooks/use-panel-resize";

interface PanelResizeHandleProps extends PanelResizeEvents {
  orientation: "horizontal" | "vertical";
  label: string;
}

export function PanelResizeHandle({
  orientation,
  label,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: PanelResizeHandleProps) {
  return (
    <div
      className={cn(
        "group relative z-20 touch-none bg-border transition-colors hover:bg-accent",
        orientation === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
      )}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <span
        className={cn(
          "absolute",
          orientation === "vertical"
            ? "inset-y-0 left-1/2 w-[7px] -translate-x-1/2"
            : "inset-x-0 top-1/2 h-[7px] -translate-y-1/2",
        )}
      />
    </div>
  );
}
