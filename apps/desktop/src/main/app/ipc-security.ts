import { CINESIM_RENDERER_ENTRY_URL } from "./protocols";

interface IpcFrameLike {
  url: string;
}

export interface IpcSenderLike {
  sender: { id: number; mainFrame: IpcFrameLike };
  senderFrame: IpcFrameLike | null;
}

export interface IpcSecurityPolicy {
  trustedRendererIds: ReadonlySet<number>;
  developmentUrl?: URL | undefined;
}

export function isTrustedRendererUrl(value: string, policy: IpcSecurityPolicy): boolean {
  try {
    const url = new URL(value);
    if (policy.developmentUrl) return url.origin === policy.developmentUrl.origin;
    return url.href === CINESIM_RENDERER_ENTRY_URL;
  } catch {
    return false;
  }
}

export function assertIpcSender(event: IpcSenderLike, policy: IpcSecurityPolicy): void {
  if (
    !policy.trustedRendererIds.has(event.sender.id) ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, policy)
  ) {
    throw new Error("Unauthorized IPC sender");
  }
}
