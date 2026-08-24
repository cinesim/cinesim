import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSFORM,
  createProject,
  type Asset,
  type Clip,
  type EditorCommand,
  type Sequence,
} from "@cinesim/core";
import type { RuntimeSnapshot } from "@cinesim/engine";
import type { DesktopApi, DesktopProjectSession } from "../src/shared/api";
import { createRendererStore, EMPTY_APP_STATE } from "../src/renderer/store/renderer-store";

function sessionFixture(directory = "/projects/fixture"): DesktopProjectSession {
  return {
    directory,
    derivedScope: {
      cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
      epoch: "00000000-0000-4000-8000-000000000001",
    },
    project: createProject({ name: "Fixture" }),
    settings: DEFAULT_SETTINGS,
    revision: 0,
    canUndo: false,
    canRedo: false,
  };
}

function apiFixture(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getSession: async () => null,
    getAppState: async () => EMPTY_APP_STATE,
    ...overrides,
  } as DesktopApi;
}

function runtimeFixture(timeUs: number): RuntimeSnapshot {
  return {
    mode: { kind: "timeline", timeUs },
    timeUs,
    playing: false,
    playbackRate: 0,
    activeAssetId: null,
    activeSourceKind: null,
    foregroundPressure: "idle",
    renderFps: 0,
    targetFps: 30,
    droppedFrames: 0,
    frameOperationsInFlight: 0,
    newestRequestPending: false,
    requestsReceived: 0,
    requestsCoalesced: 0,
    framesPresented: 0,
    framesObsolete: 0,
    failedRequests: 0,
    activeSources: 0,
    activeClips: 0,
    seekLatencyMs: 0,
    gpuSubmitCpuMs: 0,
    gpuSubmittedFrames: 0,
    gpuDeviceLostCount: 0,
    previewWidth: 1920,
    previewHeight: 1080,
    sourcePreviewSuppressions: 0,
  };
}

describe("renderer project controller", () => {
  it("opens the canonical session even when optional app preferences cannot load", async () => {
    const session = sessionFixture();
    const store = createRendererStore({
      api: apiFixture({
        getSession: async () => session,
        getAppState: async () => Promise.reject(new Error("Preferences unavailable")),
      }),
    });

    await store.getState().initialize();

    expect(store.getState().project).toEqual({ status: "ready", session });
    expect(store.getState().appState).toBe(EMPTY_APP_STATE);
  });

  it("keeps project-opening failures in controller state after the initiating view unmounts", async () => {
    const store = createRendererStore({
      api: apiFixture({ openProject: async () => Promise.reject(new Error("Unreadable project")) }),
    });
    await store.getState().initialize();

    const result = await store.getState().openProject();

    expect(result).toEqual({ ok: false, error: "Unreadable project" });
    expect(store.getState().project).toEqual({
      status: "failed",
      previousSession: null,
      error: "Unreadable project",
    });
    expect(store.getState().operationError).toBe("Unreadable project");
  });

  it("preserves a viewed sequence across edits and reconciles stale selection and playhead", async () => {
    const session = sessionFixture();
    const asset: Asset = {
      id: "asset_fixture",
      kind: "video",
      name: "Fixture.mov",
      source: { kind: "local", path: "/media/fixture.mov" },
      durationUs: 4_000_000,
    };
    const clip: Clip = {
      id: "clip_selected",
      assetId: asset.id,
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: 4_000_000,
      transform: DEFAULT_TRANSFORM,
    };
    const secondSequence: Sequence = {
      ...session.project.sequences[0]!,
      id: "sequence_second",
      name: "Second timeline",
      tracks: session.project.sequences[0]!.tracks.map((track, index) => ({
        ...track,
        id: index === 0 ? "track_second_video" : "track_second_audio",
        clips: index === 0 ? [clip] : [],
      })),
    };
    session.project = {
      ...session.project,
      assets: [asset],
      sequences: [...session.project.sequences, secondSequence],
    };
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session }),
    });
    await store.getState().initialize();
    store.getState().showTimeline(secondSequence.id);
    store.getState().selectClip(clip.id);
    store.getState().setPlayheadUs(3_000_000);

    await store.getState().receiveExternalSession({
      ...session,
      revision: 1,
      project: {
        ...session.project,
        sequences: session.project.sequences.map((sequence) =>
          sequence.id === secondSequence.id
            ? {
                ...sequence,
                tracks: sequence.tracks.map((track) => ({ ...track, clips: [] })),
              }
            : sequence,
        ),
      },
    });

    expect(store.getState().activeSequenceId).toBe(secondSequence.id);
    expect(store.getState().selectedClipId).toBeNull();
    expect(store.getState().playheadUs).toBe(0);
  });

  it("scopes runtime snapshots to the current project and sequence", async () => {
    const session = sessionFixture();
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session }),
    });
    await store.getState().initialize();
    const sequenceId = session.project.activeSequenceId;

    store.getState().setPlaybackRuntime("/projects/stale", sequenceId, runtimeFixture(1_000_000));
    expect(store.getState().playbackRuntime).toBeNull();

    store
      .getState()
      .setPlaybackRuntime(session.directory, "sequence_stale", runtimeFixture(2_000_000));
    expect(store.getState().playbackRuntime).toBeNull();

    store.getState().setPlaybackRuntime(session.directory, sequenceId, runtimeFixture(3_000_000));
    expect(store.getState().playbackRuntime?.sequenceId).toBe(sequenceId);
    expect(store.getState().playheadUs).toBe(3_000_000);
  });

  it("appends an asset to the explicitly requested sequence", async () => {
    const session = sessionFixture();
    const asset: Asset = {
      id: "asset_fixture",
      kind: "video",
      name: "Fixture.mov",
      source: { kind: "local", path: "/media/fixture.mov" },
      durationUs: 5_000_000,
    };
    const secondSequence: Sequence = {
      ...session.project.sequences[0]!,
      id: "sequence_second",
      tracks: session.project.sequences[0]!.tracks.map((track, index) => ({
        ...track,
        id: index === 0 ? "track_second_video" : "track_second_audio",
        clips: [],
      })),
    };
    session.project = {
      ...session.project,
      assets: [asset],
      sequences: [...session.project.sequences, secondSequence],
    };
    const execute = vi.fn(async (command: EditorCommand) => ({
      session,
      result: { command, changedIds: [], createdIds: [], summary: "Added clip" },
    }));
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session, execute }),
    });
    await store.getState().initialize();

    const result = await store.getState().appendAsset(asset.id, secondSequence.id);

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith({
      type: "clip.add",
      trackId: "track_second_video",
      assetId: asset.id,
      timelineStartUs: 0,
    });
  });

  it("appends to the first unlocked compatible track", async () => {
    const session = sessionFixture();
    const asset: Asset = {
      id: "asset_fixture",
      kind: "video",
      name: "Fixture.mov",
      source: { kind: "local", path: "/media/fixture.mov" },
      durationUs: 5_000_000,
    };
    const sequence = session.project.sequences[0]!;
    sequence.tracks[0]!.locked = true;
    sequence.tracks.push({
      id: "track_overlay",
      name: "Overlay 1",
      kind: "overlay",
      muted: false,
      locked: false,
      clips: [],
    });
    session.project.assets = [asset];
    const execute = vi.fn(async (command: EditorCommand) => ({
      session,
      result: { command, changedIds: [], createdIds: [], summary: "Added clip" },
    }));
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session, execute }),
    });
    await store.getState().initialize();

    const result = await store.getState().appendAsset(asset.id, sequence.id);

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith({
      type: "clip.add",
      trackId: "track_overlay",
      assetId: asset.id,
      timelineStartUs: 0,
    });
  });
});
