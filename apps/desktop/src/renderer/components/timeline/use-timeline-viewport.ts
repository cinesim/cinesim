import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UIEvent, WheelEvent } from "react";
import type { TimeUs } from "@cinesim/core";
import { timelinePresentationForHeight } from "../../../shared/transcript";
import { useElementBounds } from "../../hooks/use-element-bounds";
import {
  BASE_TIMELINE_PIXELS_PER_SECOND,
  clampTimelineZoom,
  timelineAnchoredScrollLeft,
  timelineContentDurationUs,
  timelineFitZoom,
} from "../../lib/timeline-scale";
import { FULL_TIMELINE_TRACK_CHROME_WIDTH } from "./timeline-behavior";

interface UseTimelineViewportOptions {
  onZoomChange: (zoom: number) => void;
  playheadUs: TimeUs;
  sequenceDurationUs: TimeUs;
  zoom: number;
}

export function useTimelineViewport({
  onZoomChange,
  playheadUs,
  sequenceDurationUs,
  zoom,
}: UseTimelineViewportOptions) {
  const rootRef = useRef<HTMLElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const pendingScrollLeft = useRef<number | null>(null);
  const rootBounds = useElementBounds(rootRef);
  const presentation = timelinePresentationForHeight(rootBounds.height || 288);
  const fallbackViewportWidth = Math.max(
    0,
    rootBounds.width - (presentation === "full" ? FULL_TIMELINE_TRACK_CHROME_WIDTH : 0),
  );
  const measuredViewportWidth = viewportWidth || fallbackViewportWidth;
  const horizontalPadding = presentation === "full" ? 0 : 16;
  const contentViewportWidth = Math.max(0, measuredViewportWidth - horizontalPadding);
  const minimumZoom = timelineFitZoom(sequenceDurationUs, contentViewportWidth);
  const pixelsPerUs = (BASE_TIMELINE_PIXELS_PER_SECOND * zoom) / 1_000_000;
  const contentDurationUs = timelineContentDurationUs(sequenceDurationUs);
  const contentWidth = Math.max(contentViewportWidth, Math.round(contentDurationUs * pixelsPerUs));

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => setViewportWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [presentation]);

  const changeZoom = useCallback(
    (requestedZoom: number) => {
      const nextZoom = clampTimelineZoom(requestedZoom, minimumZoom);
      if (nextZoom === zoom) return;
      const viewport = scrollRef.current;
      if (viewport) {
        const nextPixelsPerUs = (BASE_TIMELINE_PIXELS_PER_SECOND * nextZoom) / 1_000_000;
        const nextContentWidth = Math.max(
          Math.max(0, viewport.clientWidth - horizontalPadding),
          Math.round(contentDurationUs * nextPixelsPerUs),
        );
        pendingScrollLeft.current = timelineAnchoredScrollLeft({
          anchorUs: playheadUs,
          currentPixelsPerUs: pixelsPerUs,
          currentScrollLeft: viewport.scrollLeft,
          nextContentWidth: nextContentWidth + horizontalPadding,
          nextPixelsPerUs,
          viewportWidth: viewport.clientWidth,
        });
      }
      onZoomChange(nextZoom);
    },
    [
      contentDurationUs,
      horizontalPadding,
      minimumZoom,
      onZoomChange,
      pixelsPerUs,
      playheadUs,
      zoom,
    ],
  );

  const fitToWidth = useCallback(() => {
    pendingScrollLeft.current = null;
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    onZoomChange(minimumZoom);
  }, [minimumZoom, onZoomChange]);

  useEffect(() => {
    if (zoom < minimumZoom) changeZoom(minimumZoom);
  }, [changeZoom, minimumZoom, zoom]);

  useLayoutEffect(() => {
    if (pendingScrollLeft.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScrollLeft.current;
    pendingScrollLeft.current = null;
  }, [contentWidth, zoom]);

  const syncHeaderScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (headerScrollRef.current) headerScrollRef.current.scrollTop = event.currentTarget.scrollTop;
  }, []);

  const scrollTracksFromHeader = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (scrollRef.current) scrollRef.current.scrollTop += event.deltaY;
  }, []);

  return {
    changeZoom,
    contentDurationUs,
    contentWidth,
    fitToWidth,
    headerScrollRef,
    minimumZoom,
    pixelsPerUs,
    presentation,
    rootRef,
    scrollRef,
    scrollTracksFromHeader,
    syncHeaderScroll,
  };
}
