import {
  AudioLines,
  Button,
  Layers,
  Magnet,
  Maximize2,
  Menu,
  MenuContent,
  MenuGroup,
  MenuIcon,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Scissors,
  Separator,
  Trash2,
  Video,
  ZoomIn,
  ZoomOut,
} from "@cinesim/ui";
import type { EditTool } from "../../store/renderer-store";
import { MAX_TIMELINE_ZOOM } from "../../lib/timeline-scale";
import { TIMELINE_PALETTES } from "./timeline-behavior";
import type { TimelinePaletteId } from "./timeline-behavior";

interface TimelineEditToolbarProps {
  canDelete: boolean;
  canSplit: boolean;
  onAddTrack: (kind: "audio" | "overlay" | "video") => void;
  onDelete: () => void;
  onPaletteChange: (paletteId: TimelinePaletteId) => void;
  onSnappingToggle: () => void;
  onSplit: () => void;
  onToolChange: (tool: EditTool) => void;
  onTrackHeightChange: (height: number) => void;
  paletteId: TimelinePaletteId;
  snappingEnabled: boolean;
  tool: EditTool;
  trackHeight: number;
}

export function TimelineEditToolbar({
  canDelete,
  canSplit,
  onAddTrack,
  onDelete,
  onPaletteChange,
  onSnappingToggle,
  onSplit,
  onToolChange,
  onTrackHeightChange,
  paletteId,
  snappingEnabled,
  tool,
  trackHeight,
}: TimelineEditToolbarProps) {
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Button
        size="icon"
        variant={tool === "select" ? "secondary" : "ghost"}
        aria-label="Selection tool"
        title="Selection tool (V)"
        onClick={() => onToolChange("select")}
      >
        <MousePointer2 size={14} />
      </Button>
      <Button
        size="icon"
        variant={tool === "trim" ? "secondary" : "ghost"}
        aria-label="Trim tool"
        title="Trim tool (T)"
        onClick={() => onToolChange("trim")}
      >
        <MoveHorizontal size={14} />
      </Button>
      <Button
        size="icon"
        variant={tool === "blade" ? "secondary" : "ghost"}
        aria-label="Blade tool"
        title="Blade tool (B)"
        onClick={() => onToolChange("blade")}
      >
        <Scissors size={14} />
      </Button>
      <Separator orientation="vertical" className="mx-1 h-4 self-auto" />
      <Menu>
        <MenuTrigger
          aria-label="Add timeline track"
          title="Add timeline track"
          className="grid size-8 place-items-center rounded-md text-secondary hover:bg-surface hover:text-primary"
        >
          <Plus size={14} />
        </MenuTrigger>
        <MenuContent align="start" className="w-48">
          <MenuGroup>
            <MenuLabel>Add track</MenuLabel>
            <MenuItem onClick={() => onAddTrack("video")}>
              <Video size={14} /> Video track
            </MenuItem>
            <MenuItem onClick={() => onAddTrack("audio")}>
              <AudioLines size={14} /> Audio track
            </MenuItem>
            <MenuItem onClick={() => onAddTrack("overlay")}>
              <Layers size={14} /> Overlay track
            </MenuItem>
          </MenuGroup>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger
          aria-label="Timeline view options"
          title="Timeline view options"
          className="grid size-8 place-items-center rounded-md text-secondary hover:bg-surface hover:text-primary"
        >
          <MenuIcon size={14} />
        </MenuTrigger>
        <MenuContent align="start" className="w-60 p-2">
          <MenuGroup>
            <MenuLabel>Track appearance</MenuLabel>
            <label className="grid gap-1 px-2 py-1 text-ui-xs text-muted">
              Height
              <input
                aria-label="Timeline track height"
                className="h-1 accent-accent"
                type="range"
                min={40}
                max={112}
                step={4}
                value={trackHeight}
                onChange={(event) => onTrackHeightChange(Number(event.target.value))}
              />
            </label>
            <MenuLabel>Clip palette</MenuLabel>
            {TIMELINE_PALETTES.map((palette) => (
              <MenuItem key={palette.id} onClick={() => onPaletteChange(palette.id)}>
                <span className="flex gap-0.5">
                  {Object.values(palette.colors).map((color) => (
                    <span
                      key={color}
                      className="size-2 rounded-full"
                      style={{ background: color }}
                    />
                  ))}
                </span>
                <span className="flex-1">{palette.name}</span>
                {paletteId === palette.id && <span aria-hidden="true">✓</span>}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuContent>
      </Menu>
      <Button
        size="icon"
        variant={snappingEnabled ? "secondary" : "ghost"}
        aria-label={snappingEnabled ? "Disable snapping" : "Enable snapping"}
        aria-pressed={snappingEnabled}
        title="Snapping (S)"
        onClick={onSnappingToggle}
      >
        <Magnet size={14} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Split selected clip"
        disabled={!canSplit}
        onClick={onSplit}
      >
        <Scissors size={14} />
      </Button>
      <Button
        size="icon"
        variant="danger"
        aria-label="Delete selected clip"
        disabled={!canDelete}
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

export function TimelineZoomControls({
  minimumZoom,
  onChange,
  onFit,
  zoom,
}: {
  minimumZoom: number;
  onChange: (zoom: number) => void;
  onFit: () => void;
  zoom: number;
}) {
  return (
    <div className="flex min-w-0 items-center justify-end gap-1">
      <Button
        size="icon"
        variant="ghost"
        aria-label="Zoom out"
        disabled={zoom <= minimumZoom + Number.EPSILON}
        onClick={() => onChange(zoom / 1.25)}
      >
        <ZoomOut size={13} />
      </Button>
      <input
        aria-label="Timeline zoom"
        className="h-1 w-20 accent-accent"
        type="range"
        min={minimumZoom}
        max={MAX_TIMELINE_ZOOM}
        step="any"
        value={zoom}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <Button
        size="icon"
        variant="ghost"
        aria-label="Zoom in"
        disabled={zoom >= MAX_TIMELINE_ZOOM - Number.EPSILON}
        onClick={() => onChange(zoom * 1.25)}
      >
        <ZoomIn size={13} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Fit timeline to width"
        title="Fit timeline to width"
        onClick={onFit}
      >
        <Maximize2 size={13} />
      </Button>
    </div>
  );
}
