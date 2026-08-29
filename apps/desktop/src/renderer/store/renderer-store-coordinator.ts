import type { StoreApi } from "zustand/vanilla";
import { sequenceDurationUs } from "@cinesim/core";
import type { DesktopApi, DesktopProjectSession } from "../../shared/api";
import {
  appStateWithRememberedProject,
  clipExists,
  EMPTY_APP_STATE,
  hydratedProjectState,
  INITIAL_ACCOUNT_STATE,
  messageFrom,
  sessionFromLifecycle,
} from "./renderer-project-state";
import type { ActionResult, RendererState } from "./renderer-state";

type SetState = StoreApi<RendererState>["setState"];
type GetState = StoreApi<RendererState>["getState"];

export class RendererStoreContext {
  #nextRequestId = 0;
  #initialization: Promise<void> | null = null;

  constructor(
    readonly api: DesktopApi,
    readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined,
    readonly set: SetState,
    readonly get: GetState,
  ) {}

  blockedByProjectOpening<T>(): ActionResult<T> | null {
    return this.get().project.status === "opening"
      ? { ok: false, error: "Wait for the project to finish opening" }
      : null;
  }

  acceptMutationSession(session: DesktopProjectSession): void {
    const current = this.get();
    const previous = sessionFromLifecycle(current.project);
    if (previous && previous.directory !== session.directory) return;
    const requestedSequenceId = current.activeSequenceId ?? session.project.activeSequenceId;
    const activeSequence =
      session.project.sequences.find((sequence) => sequence.id === requestedSequenceId) ??
      session.project.sequences.find(
        (sequence) => sequence.id === session.project.activeSequenceId,
      ) ??
      null;
    const activeSequenceId = activeSequence?.id ?? null;
    const sequenceChanged = activeSequenceId !== current.activeSequenceId;
    this.set({
      project: { status: "ready", session },
      operationError: null,
      activeSequenceId,
      selectedClipId: clipExists(activeSequence, current.selectedClipId)
        ? current.selectedClipId
        : null,
      playheadUs: activeSequence
        ? Math.min(current.playheadUs, sequenceDurationUs(activeSequence))
        : 0,
      playbackRuntime: sequenceChanged ? null : current.playbackRuntime,
    });
  }

  async runProjectOperation<T extends DesktopProjectSession | null>(
    operation: "create" | "open" | "open-recent",
    invoke: () => Promise<T>,
  ): Promise<ActionResult<T>> {
    if (this.get().project.status === "opening")
      return { ok: false, error: "Another project operation is already in progress" };
    const requestId = ++this.#nextRequestId;
    const previousSession = sessionFromLifecycle(this.get().project);
    this.set({
      project: { status: "opening", operation, previousSession, requestId },
      operationError: null,
    });
    try {
      const session = await invoke();
      const currentProject = this.get().project;
      if (currentProject.status !== "opening" || currentProject.requestId !== requestId)
        return { ok: false, error: "A newer project operation replaced this request" };
      if (!session) {
        this.set({
          project: previousSession
            ? { status: "ready", session: previousSession }
            : { status: "idle" },
        });
        return { ok: true, value: session };
      }
      const appState = appStateWithRememberedProject(this.get().appState, session);
      const [transfersResult, downloadsResult] = await Promise.allSettled([
        this.api.getCloudTransfers?.() ?? Promise.resolve([]),
        this.api.getDownloadedCloudOriginals?.() ?? Promise.resolve([]),
      ]);
      this.set({
        ...hydratedProjectState(session, appState),
        cloudTransfers: transfersResult.status === "fulfilled" ? transfersResult.value : [],
        downloadedCloudOriginals:
          downloadsResult.status === "fulfilled" ? downloadsResult.value : [],
      });
      return { ok: true, value: session };
    } catch (error) {
      const message = messageFrom(error, "The project could not be opened");
      this.set({
        project: { status: "failed", previousSession, error: message },
        destination: previousSession ? this.get().destination : "home",
        operationError: message,
      });
      return { ok: false, error: message };
    }
  }

  async runSessionAction(
    invoke: () => Promise<DesktopProjectSession>,
    fallback: string,
  ): Promise<ActionResult<DesktopProjectSession>> {
    const blocked = this.blockedByProjectOpening<DesktopProjectSession>();
    if (blocked) return blocked;
    this.set({ operationError: null });
    try {
      const session = await invoke();
      this.acceptMutationSession(session);
      return { ok: true, value: session };
    } catch (error) {
      const message = messageFrom(error, fallback);
      this.set({ operationError: message });
      return { ok: false, error: message };
    }
  }

  async hydrateAccountWorkspace(): Promise<void> {
    const [sessionResult, appStateResult, transfersResult, downloadsResult] =
      await Promise.allSettled([
        this.api.getSession(),
        this.api.getAppState(),
        this.api.getCloudTransfers?.() ?? Promise.resolve([]),
        this.api.getDownloadedCloudOriginals?.() ?? Promise.resolve([]),
      ]);
    if (sessionResult.status === "rejected") {
      const message = messageFrom(sessionResult.reason, "Cinesim could not load your projects");
      this.set({
        project: { status: "failed", previousSession: null, error: message },
        appState: EMPTY_APP_STATE,
        cloudTransfers: [],
        downloadedCloudOriginals: [],
        operationError: message,
      });
      return;
    }
    const appState = appStateResult.status === "fulfilled" ? appStateResult.value : EMPTY_APP_STATE;
    const cloudTransfers = transfersResult.status === "fulfilled" ? transfersResult.value : [];
    const downloadedCloudOriginals =
      downloadsResult.status === "fulfilled" ? downloadsResult.value : [];
    if (sessionResult.value)
      this.set({
        ...hydratedProjectState(sessionResult.value, appState),
        cloudTransfers,
        downloadedCloudOriginals,
      });
    else
      this.set({
        project: { status: "idle" },
        appState,
        cloudTransfers,
        downloadedCloudOriginals,
      });
  }

  initialize(): Promise<void> {
    if (this.#initialization) return this.#initialization;
    if (this.get().project.status !== "booting") return Promise.resolve();
    this.#initialization = (async () => {
      const workspace = this.hydrateAccountWorkspace();
      const account = await this.api.getAccountSnapshot().catch(() => INITIAL_ACCOUNT_STATE);
      this.set({ account, accountHydrated: true });
      await workspace;
      const accountAppState = await this.api.getAppState().catch(() => null);
      if (accountAppState) this.set({ appState: accountAppState });
    })();
    return this.#initialization;
  }
}
