import { createStore } from "zustand/vanilla";
import type { DesktopApi } from "../../shared/contracts";
import { createAccountCloudSlice } from "./account-cloud-slice";
import { createEditorInteractionSlice } from "./editor-interaction-slice";
import { createPlaybackMediaSlice } from "./playback-media-slice";
import { createProjectSlice } from "./project-slice";
import type { RendererState } from "./renderer-state";
import { RendererStoreContext } from "./renderer-store-coordinator";

export * from "./renderer-project-state";
export * from "./renderer-state";

interface RendererStoreDependencies {
  api: DesktopApi;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export type RendererStoreApi = ReturnType<typeof createRendererStore>;

export function createRendererStore({ api, storage }: RendererStoreDependencies) {
  return createStore<RendererState>()((set, get) => {
    const context = new RendererStoreContext(api, storage, set, get);
    return {
      ...createProjectSlice(context),
      ...createEditorInteractionSlice(context),
      ...createPlaybackMediaSlice(context),
      ...createAccountCloudSlice(context),
    };
  });
}
