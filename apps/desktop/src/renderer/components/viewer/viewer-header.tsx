import { Maximize2 } from "@cinesim/ui";
import { Button, DropdownSelect, PaneHeader } from "@cinesim/ui";
import type { RuntimeSnapshot } from "@cinesim/engine";
import { ViewerGuideMenu } from "./viewer-guides";
import type { ViewerGuides } from "./viewer-guides";
import { VIEWER_SCALE_OPTIONS } from "./viewer-helpers";
import type { ViewerScale } from "./viewer-helpers";

interface ViewerHeaderProps {
  frameRate: number;
  guides: ViewerGuides;
  height: number;
  onFullscreen: () => void;
  onGuidesChange: (guides: ViewerGuides) => void;
  onScaleChange: (scale: ViewerScale) => void;
  runtime: RuntimeSnapshot | null;
  scale: ViewerScale;
  width: number;
}

export function ViewerHeader({
  frameRate,
  guides,
  height,
  onFullscreen,
  onGuidesChange,
  onScaleChange,
  runtime,
  scale,
  width,
}: ViewerHeaderProps) {
  return (
    <PaneHeader size="sm" className="min-w-0 gap-2 overflow-hidden px-3">
      <span className="min-w-0 flex-1" />
      {runtime?.playing && Math.abs(runtime.playbackRate) !== 1 && (
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-secondary tabular-nums">
          {runtime.playbackRate > 0 ? "+" : "−"}
          {Math.abs(runtime.playbackRate)}×
        </span>
      )}
      {runtime?.activeSourceKind && (
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          {runtime.activeSourceKind === "proxy" ? "Proxy" : "Original"}
        </span>
      )}
      <DropdownSelect
        aria-label="Viewer zoom"
        className="viewer-zoom w-[76px] shrink-0"
        options={VIEWER_SCALE_OPTIONS}
        value={scale}
        onValueChange={onScaleChange}
      />
      <ViewerGuideMenu guides={guides} onChange={onGuidesChange} />
      <Button
        size="icon"
        variant="ghost"
        aria-label="Fullscreen viewer"
        title="Fullscreen viewer"
        onClick={onFullscreen}
      >
        <Maximize2 size={14} />
      </Button>
      <span className="viewer-resolution shrink-0 rounded bg-surface px-2 py-1 text-ui-xs text-muted tabular-nums">
        {width} × {height} · {frameRate} fps
      </span>
    </PaneHeader>
  );
}
