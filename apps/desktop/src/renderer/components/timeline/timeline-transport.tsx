import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pause, Play } from "lucide-react";
import { Button } from "@cinesim/ui";
import type { TimeUs } from "@cinesim/core";
import { formatTimecode } from "../../lib/format";

interface TimelineTransportProps {
  durationUs: TimeUs;
  frameRate: number;
  onGoToStart?: () => void;
  onSeek?: (timeUs: TimeUs) => void;
  onStepFrames?: (deltaFrames: number) => void;
  onTogglePlayback?: () => void;
  playbackRate?: number;
  playheadUs: TimeUs;
  playing: boolean;
}

export function TimelineTransport({
  durationUs,
  frameRate,
  onGoToStart,
  onSeek,
  onStepFrames,
  onTogglePlayback,
  playbackRate = 1,
  playheadUs,
  playing,
}: TimelineTransportProps) {
  return (
    <div className="flex h-full items-center gap-1">
      <span className="mr-2 inline-flex h-9 min-w-[100px] items-center justify-center px-2 text-center text-[13px] leading-none font-semibold text-primary tabular-nums">
        {formatTimecode(playheadUs, frameRate)}
      </span>
      <Button
        size="icon-lg"
        variant="ghost"
        aria-label="Go to timeline beginning"
        title="Go to beginning (Home)"
        onClick={onGoToStart}
      >
        <ChevronsLeft size={20} strokeWidth={1.8} />
      </Button>
      <Button
        size="icon-lg"
        variant="ghost"
        aria-label="Previous frame"
        title="Previous frame (Left Arrow)"
        onClick={() => onStepFrames?.(-1)}
      >
        <ChevronLeft size={20} strokeWidth={1.8} />
      </Button>
      <Button
        size="icon-lg"
        variant="ghost"
        aria-label={playing ? "Pause" : "Play"}
        title="Play or pause (Space)"
        onClick={onTogglePlayback}
      >
        {playing ? (
          <Pause size={20} fill="currentColor" strokeWidth={1.8} />
        ) : (
          <Play className="ml-0.5" size={20} fill="currentColor" strokeWidth={1.8} />
        )}
      </Button>
      <Button
        size="icon-lg"
        variant="ghost"
        aria-label="Next frame"
        title="Next frame (Right Arrow)"
        onClick={() => onStepFrames?.(1)}
      >
        <ChevronRight size={20} strokeWidth={1.8} />
      </Button>
      <Button
        size="icon-lg"
        variant="ghost"
        aria-label="Go to timeline end"
        title="Go to end (End)"
        onClick={() => onSeek?.(durationUs)}
      >
        <ChevronsRight size={20} strokeWidth={1.8} />
      </Button>
      {playing && Math.abs(playbackRate) !== 1 && (
        <span className="px-1 text-[9px] font-semibold text-muted tabular-nums">
          {playbackRate > 0 ? "+" : "−"}
          {Math.abs(playbackRate)}×
        </span>
      )}
    </div>
  );
}
