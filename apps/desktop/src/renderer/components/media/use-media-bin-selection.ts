import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetId } from "@cinesim/core";
import { rectangleFromPoints, rectanglesIntersect, updateAssetSelection } from "./media-bin-model";
import type { Point, Rectangle, SelectionModifiers } from "./media-bin-model";

interface UseMediaBinSelectionOptions {
  availableAssetIds: readonly AssetId[];
  visibleAssetIds: readonly AssetId[];
}

export function useMediaBinSelection({
  availableAssetIds,
  visibleAssetIds,
}: UseMediaBinSelectionOptions) {
  const [selection, setSelection] = useState<Set<AssetId>>(() => new Set());
  const [anchor, setAnchor] = useState<AssetId | null>(null);
  const [marquee, setMarquee] = useState<Rectangle | null>(null);
  const marqueeOrigin = useRef<Point | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectedIds = useMemo(() => {
    const available = new Set(availableAssetIds);
    return new Set([...selection].filter((assetId) => available.has(assetId)));
  }, [availableAssetIds, selection]);

  const clear = useCallback(() => {
    setSelection(new Set());
    setAnchor(null);
  }, []);

  const selectOnly = useCallback((assetId: AssetId) => {
    setSelection(new Set([assetId]));
    setAnchor(assetId);
  }, []);

  const select = useCallback(
    (assetId: AssetId, modifiers: SelectionModifiers) => {
      const next = updateAssetSelection(selection, visibleAssetIds, assetId, anchor, modifiers);
      setSelection(next.selectedIds);
      setAnchor(next.anchor);
    },
    [anchor, selection, visibleAssetIds],
  );

  const beginMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    marqueeOrigin.current = { x: event.clientX, y: event.clientY };
    setSelection(new Set());
    setAnchor(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const moveMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const origin = marqueeOrigin.current;
    if (!origin) return;
    const rectangle = rectangleFromPoints(origin, { x: event.clientX, y: event.clientY });
    setMarquee(rectangle);
    const next = new Set<AssetId>();
    for (const element of gridRef.current?.querySelectorAll<HTMLElement>("[data-asset-id]") ?? []) {
      if (rectanglesIntersect(rectangle, element.getBoundingClientRect()))
        next.add(element.dataset.assetId as AssetId);
    }
    setSelection(next);
  }, []);

  const finishMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!marqueeOrigin.current) return;
    marqueeOrigin.current = null;
    setMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") clear();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [clear]);

  return {
    beginMarquee,
    clear,
    finishMarquee,
    gridRef,
    marquee,
    moveMarquee,
    select,
    selectedIds,
    selectOnly,
  };
}
