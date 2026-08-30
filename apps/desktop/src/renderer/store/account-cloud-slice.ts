import { EMPTY_APP_STATE, messageFrom, sessionFromLifecycle } from "./renderer-project-state";
import type { AccountCloudSlice } from "./renderer-state";
import type { RendererStoreContext } from "./renderer-store-coordinator";

export function createAccountCloudSlice(context: RendererStoreContext): AccountCloudSlice {
  const { api, get, set } = context;
  return {
    account: {
      status: "signed-out",
      cloudOrigin: null,
      serviceAvailable: false,
      googleSignIn: false,
      cloudStorage: false,
      transcription: false,
      user: null,
      detail: null,
    },
    accountHydrated: false,
    cloudTransfers: [],
    downloadedCloudOriginals: [],
    setAccount: (account) => {
      const previousUserId = get().account.user?.id ?? null;
      set({ account, accountHydrated: true });
      const session = sessionFromLifecycle(get().project);
      if (!account.user) {
        set(
          session?.project.cloudProjectId
            ? {
                project: { status: "idle" },
                destination: "home",
                cloudTransfers: [],
                downloadedCloudOriginals: [],
              }
            : { cloudTransfers: [], downloadedCloudOriginals: [] },
        );
        void api.appState
          .get()
          .then((appState) => set({ appState }))
          .catch(() => undefined);
      } else if (account.user.id !== previousUserId) {
        if (session?.project.cloudProjectId) {
          set({
            project: { status: "booting" },
            appState: EMPTY_APP_STATE,
            cloudTransfers: [],
            downloadedCloudOriginals: [],
          });
          void context.hydrateAccountWorkspace();
        } else {
          void api.appState
            .get()
            .then((appState) => set({ appState }))
            .catch(() => undefined);
        }
      }
    },
    refreshAccount: async () => {
      try {
        get().setAccount(await api.account.get());
      } catch {
        set({
          account: {
            ...get().account,
            status: get().account.user ? "offline" : "signed-out",
            serviceAvailable: false,
            detail: "The authentication service is unavailable. Local editing still works.",
          },
          accountHydrated: true,
        });
      }
    },
    beginAccountSignIn: async (method) => {
      try {
        await api.account.beginSignIn(method);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: messageFrom(error, "Sign-in could not be started") };
      }
    },
    signOutAccount: async () => {
      try {
        const account = await api.account.signOut();
        get().setAccount(account);
        return { ok: true, value: account };
      } catch (error) {
        return { ok: false, error: messageFrom(error, "Could not sign out") };
      }
    },
    setCloudTransfers: (cloudTransfers) => set({ cloudTransfers }),
    retryCloudTransfer: (assetId) =>
      updateTransfers(
        context,
        () => api.cloud.retryTransfer(assetId),
        "The cloud transfer could not be retried",
      ),
    cancelCloudTransfer: (assetId) =>
      updateTransfers(
        context,
        () => api.cloud.cancelTransfer(assetId),
        "The cloud transfer could not be canceled",
      ),
    keepCloudOriginalDownloaded: async (assetId) => {
      try {
        const downloadedCloudOriginals = await api.cloud.keepOriginalDownloaded(assetId);
        set({ downloadedCloudOriginals, operationError: null });
        return { ok: true, value: downloadedCloudOriginals };
      } catch (error) {
        const message = messageFrom(error, "The cloud original could not be downloaded");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
    removeCloudOriginalDownload: async (assetId) => {
      try {
        const downloadedCloudOriginals = await api.cloud.removeOriginalDownload(assetId);
        set({ downloadedCloudOriginals, operationError: null });
        return { ok: true, value: downloadedCloudOriginals };
      } catch (error) {
        const message = messageFrom(error, "The downloaded original could not be removed");
        set({ operationError: message });
        return { ok: false, error: message };
      }
    },
  };
}

async function updateTransfers(
  context: RendererStoreContext,
  operation: () => Promise<ReturnType<RendererStoreContext["get"]>["cloudTransfers"]>,
  fallback: string,
) {
  try {
    const cloudTransfers = await operation();
    context.set({ cloudTransfers, operationError: null });
    return { ok: true as const, value: cloudTransfers };
  } catch (error) {
    const message = messageFrom(error, fallback);
    context.set({ operationError: message });
    return { ok: false as const, error: message };
  }
}
