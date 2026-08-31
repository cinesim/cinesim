import { protocol, session } from "electron";

export const CINESIM_RENDERER_SCHEME = "cinesim";
export const CINESIM_RENDERER_HOST = "app";
export const CINESIM_RENDERER_ORIGIN = `${CINESIM_RENDERER_SCHEME}://${CINESIM_RENDERER_HOST}`;
export const CINESIM_RENDERER_ENTRY_URL = `${CINESIM_RENDERER_ORIGIN}/index.html`;
export const CINESIM_MEDIA_SCHEME = "cinesim-media";
export const EDITOR_SESSION_PARTITION = "persist:cinesim-editor";

export function registerCinesimSchemes(accountScheme: string): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CINESIM_RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
    {
      scheme: CINESIM_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
    { scheme: accountScheme, privileges: { secure: true } },
  ]);
}

export function editorSession(): Electron.Session {
  return session.fromPartition(EDITOR_SESSION_PARTITION);
}
