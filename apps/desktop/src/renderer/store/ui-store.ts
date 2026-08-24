import { create } from "zustand";
import type { ClipId, TimeUs } from "@cinesim/core";
import type { RuntimeSnapshot } from "@cinesim/engine";
import type { DerivedMediaSnapshot } from "../../shared/api";

export type EditTool = "select" | "blade";

interface UiState {
  selectedClipId: ClipId | null;
  timelineZoom: number;
  tool: EditTool;
  playheadUs: TimeUs;
  runtime: RuntimeSnapshot | null;
  derivedMedia: DerivedMediaSnapshot | null;
  selectClip: (id: ClipId | null) => void;
  setTimelineZoom: (zoom: number) => void;
  setTool: (tool: EditTool) => void;
  setPlayheadUs: (timeUs: TimeUs) => void;
  setRuntime: (runtime: RuntimeSnapshot) => void;
  setDerivedMedia: (snapshot: DerivedMediaSnapshot | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedClipId: null,
  timelineZoom: 1,
  tool: "select",
  playheadUs: 0,
  runtime: null,
  derivedMedia: null,
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setTimelineZoom: (timelineZoom) =>
    set({ timelineZoom: Math.min(4, Math.max(0.25, timelineZoom)) }),
  setTool: (tool) => set({ tool }),
  setPlayheadUs: (playheadUs) => set({ playheadUs }),
  setRuntime: (runtime) => set({ runtime, playheadUs: runtime.timeUs }),
  setDerivedMedia: (derivedMedia) => set({ derivedMedia }),
}));
