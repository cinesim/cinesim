import { clampTimelineZoom } from "../lib/timeline-scale";
import type { EditorInteractionSlice } from "./renderer-state";
import type { RendererStoreContext } from "./renderer-store-coordinator";

export function createEditorInteractionSlice(
  context: RendererStoreContext,
): EditorInteractionSlice {
  const { set } = context;
  return {
    selectedClipId: null,
    timelineZoom: 1,
    timelineTrackHeight: 56,
    timelineDragging: false,
    snappingEnabled: true,
    tool: "select",
    playheadUs: 0,
    selectClip: (selectedClipId) => set({ selectedClipId }),
    setTimelineZoom: (timelineZoom) => set({ timelineZoom: clampTimelineZoom(timelineZoom) }),
    setTimelineTrackHeight: (timelineTrackHeight) =>
      set({ timelineTrackHeight: Math.min(112, Math.max(40, Math.round(timelineTrackHeight))) }),
    setTimelineDragging: (timelineDragging) => set({ timelineDragging }),
    toggleSnapping: () => set((state) => ({ snappingEnabled: !state.snappingEnabled })),
    setTool: (tool) => set({ tool }),
    setPlayheadUs: (playheadUs) => set({ playheadUs }),
  };
}
