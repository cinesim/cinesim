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
import type { AccountSnapshot } from "../src/shared/api";
import {
  createRendererStore,
  EMPTY_APP_STATE,
  INITIAL_ACCOUNT_STATE,
} from "../src/renderer/store/renderer-store";

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
    getAccountSnapshot: async () => SIGNED_IN_ACCOUNT,
    ...overrides,
  } as DesktopApi;
}

const SIGNED_IN_ACCOUNT: AccountSnapshot = {
  ...INITIAL_ACCOUNT_STATE,
  status: "signed-in",
  serviceAvailable: true,
  cloudStorage: true,
  user: {
    id: "user_fixture",
    name: "Cine Sim",
    email: "cine@example.com",
    emailVerified: true,
    image: null,
  },
};

const SIGNED_OUT_ACCOUNT: AccountSnapshot = {
  ...INITIAL_ACCOUNT_STATE,
  status: "signed-out",
  serviceAvailable: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
    masterPeakDb: [-60, -60],
  };
}

describe("renderer project controller", () => {
  it("hydrates local projects without waiting for account identity", async () => {
    const session = sessionFixture();
    const account = deferred<AccountSnapshot>();
    const getSession = vi.fn(async () => session);
    const getAppState = vi.fn(async () => EMPTY_APP_STATE);
    const getAccountSnapshot = vi.fn(() => account.promise);
    const store = createRendererStore({
      api: apiFixture({ getSession, getAppState, getAccountSnapshot }),
    });

    const firstInitialization = store.getState().initialize();
    const secondInitialization = store.getState().initialize();

    await Promise.resolve();
    await vi.waitFor(() => expect(store.getState().project.status).toBe("ready"));
    expect(store.getState().accountHydrated).toBe(false);
    expect(getSession).toHaveBeenCalledOnce();
    expect(getAppState).toHaveBeenCalledOnce();
    expect(getAccountSnapshot).toHaveBeenCalledOnce();

    account.resolve(SIGNED_IN_ACCOUNT);
    await Promise.all([firstInitialization, secondInitialization]);
    expect(store.getState().project.status).toBe("ready");
    expect(store.getState().accountHydrated).toBe(true);
    expect(getAppState).toHaveBeenCalledTimes(2);
  });

  it("refreshes account-scoped cloud recents after startup identity resolves", async () => {
    const account = deferred<AccountSnapshot>();
    let identityResolved = false;
    const localProject = {
      name: "Local",
      directory: "/projects/local",
      kind: "local" as const,
    };
    const cloudProject = {
      name: "Cloud",
      directory: "/projects/cloud",
      kind: "cloud" as const,
    };
    const getAppState = vi.fn(async () => ({
      ...EMPTY_APP_STATE,
      recentProjects: identityResolved ? [cloudProject, localProject] : [localProject],
    }));
    const store = createRendererStore({
      api: apiFixture({
        getAccountSnapshot: async () => {
          const snapshot = await account.promise;
          identityResolved = true;
          return snapshot;
        },
        getAppState,
      }),
    });

    const initialization = store.getState().initialize();
    await vi.waitFor(() => expect(store.getState().project.status).toBe("idle"));
    expect(store.getState().appState.recentProjects).toEqual([localProject]);

    account.resolve(SIGNED_IN_ACCOUNT);
    await initialization;

    expect(getAppState).toHaveBeenCalledTimes(2);
    expect(store.getState().appState.recentProjects).toEqual([cloudProject, localProject]);
  });

  it("keeps a local project open after sign-out", async () => {
    const session = sessionFixture();
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session }),
    });
    await store.getState().initialize();

    store.getState().setAccount(SIGNED_OUT_ACCOUNT);

    expect(store.getState().project).toEqual({ status: "ready", session });
  });

  it("closes a cloud project view after sign-out", async () => {
    const session = sessionFixture();
    session.project = createProject({
      name: "Cloud fixture",
      cloudProjectId: "cloud_project_fixture0000001",
    });
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session }),
    });
    await store.getState().initialize();

    store.getState().setAccount(SIGNED_OUT_ACCOUNT);

    expect(store.getState().project).toEqual({ status: "idle" });
    expect(store.getState().destination).toBe("home");
  });

  it("hydrates and updates disposable cloud-original downloads", async () => {
    const getDownloadedCloudOriginals = vi.fn(async () => ["asset_fixture"]);
    const keepCloudOriginalDownloaded = vi.fn(async () => ["asset_fixture", "asset_second"]);
    const removeCloudOriginalDownload = vi.fn(async () => ["asset_second"]);
    const store = createRendererStore({
      api: apiFixture({
        getSession: async () => sessionFixture(),
        getDownloadedCloudOriginals,
        keepCloudOriginalDownloaded,
        removeCloudOriginalDownload,
      }),
    });

    await store.getState().initialize();
    expect(store.getState().downloadedCloudOriginals).toEqual(["asset_fixture"]);

    await expect(store.getState().keepCloudOriginalDownloaded("asset_second")).resolves.toEqual({
      ok: true,
      value: ["asset_fixture", "asset_second"],
    });
    expect(store.getState().downloadedCloudOriginals).toEqual(["asset_fixture", "asset_second"]);

    await expect(store.getState().removeCloudOriginalDownload("asset_fixture")).resolves.toEqual({
      ok: true,
      value: ["asset_second"],
    });
    expect(store.getState().downloadedCloudOriginals).toEqual(["asset_second"]);
  });

  it("keeps the previous project visible while opening and avoids a second preferences fetch", async () => {
    const previous = sessionFixture("/projects/previous");
    const next = sessionFixture("/projects/next");
    const opening = deferred<DesktopProjectSession>();
    const getAppState = vi.fn(async () => EMPTY_APP_STATE);
    const save = vi.fn(async () => previous);
    const store = createRendererStore({
      api: apiFixture({
        getSession: async () => previous,
        getAppState,
        openRecentProject: () => opening.promise,
        save,
      }),
    });
    await store.getState().initialize();
    const preferenceFetchesAfterInitialization = getAppState.mock.calls.length;

    const result = store.getState().openRecentProject(next.directory);
    expect(store.getState().project).toMatchObject({
      status: "opening",
      previousSession: previous,
    });
    await expect(store.getState().save()).resolves.toEqual({
      ok: false,
      error: "Wait for the project to finish opening",
    });
    expect(save).not.toHaveBeenCalled();

    opening.resolve(next);
    await result;

    expect(getAppState).toHaveBeenCalledTimes(preferenceFetchesAfterInitialization);
    expect(store.getState().project).toEqual({ status: "ready", session: next });
    expect(store.getState().appState.recentProjects[0]).toEqual({
      name: next.project.name,
      directory: next.directory,
      kind: "local",
    });
  });

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
      mediaKind: "video",
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

  it("forgets project metadata without closing the active project", async () => {
    const session = sessionFixture();
    const forgetProject = vi.fn(async () => EMPTY_APP_STATE);
    const store = createRendererStore({
      api: apiFixture({ getSession: async () => session, forgetProject }),
    });
    await store.getState().initialize();

    const result = await store.getState().forgetProject(session.directory);

    expect(result.ok).toBe(true);
    expect(forgetProject).toHaveBeenCalledWith(session.directory);
    expect(store.getState().project).toEqual({ status: "ready", session });
  });

  it("unmounts the active project before moving its directory to Trash", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const session = sessionFixture();
    let store: ReturnType<typeof createRendererStore>;
    const trashProject = vi.fn(async () => {
      expect(store.getState().project).toEqual({ status: "idle" });
      return EMPTY_APP_STATE;
    });
    store = createRendererStore({
      api: apiFixture({ getSession: async () => session, trashProject }),
    });
    await store.getState().initialize();

    const result = await store.getState().trashProject(session.directory);

    expect(result.ok).toBe(true);
    expect(trashProject).toHaveBeenCalledWith(session.directory);
    expect(store.getState().destination).toBe("home");
  });
});
