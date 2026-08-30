import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

interface IpcFrameLike {
  url: string;
}

export interface IpcSenderLike {
  sender: { id: number; mainFrame: IpcFrameLike };
  senderFrame: IpcFrameLike | null;
}

export interface IpcSecurityPolicy {
  trustedRendererIds: ReadonlySet<number>;
  developmentUrl?: string | undefined;
  applicationPath: string;
}

export function isTrustedRendererUrl(value: string, policy: IpcSecurityPolicy): boolean {
  try {
    const url = new URL(value);
    if (policy.developmentUrl) return url.origin === new URL(policy.developmentUrl).origin;
    if (url.protocol !== "file:") return false;
    return (
      resolve(fileURLToPath(url)) ===
      resolve(join(policy.applicationPath, "dist/renderer/index.html"))
    );
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
