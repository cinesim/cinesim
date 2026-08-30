import { createContext, useContext, useEffect, useState } from "react";
import { useRendererStoreApi } from "../../store/renderer-store-context";
import { EditorTransportController } from "./editor-transport";

const EditorTransportContext = createContext<EditorTransportController | null>(null);

export function EditorTransportProvider({ children }: { children: React.ReactNode }) {
  const store = useRendererStoreApi();
  const [transport] = useState(
    () =>
      new EditorTransportController({
        isPlaying: () => store.getState().playbackRuntime?.snapshot.playing ?? false,
        setPlayheadUs: (timeUs) => store.getState().setPlayheadUs(timeUs),
      }),
  );

  useEffect(
    () =>
      store.subscribe((state) => {
        transport.observePlayback(
          state.playheadUs,
          state.playbackRuntime?.snapshot.playing ?? false,
        );
      }),
    [store, transport],
  );

  useEffect(() => () => transport.registerController(null), [transport]);

  return <EditorTransportContext value={transport}>{children}</EditorTransportContext>;
}

export function useEditorTransport(): EditorTransportController {
  const transport = useContext(EditorTransportContext);
  if (!transport)
    throw new Error("Editor transport is unavailable outside EditorTransportProvider");
  return transport;
}
