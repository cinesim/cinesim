import type { TranscriptSnapshot } from "../transcript";
import type { AgentProjectDelta } from "./agents";
import type { CloudTransferSnapshot } from "./cloud";
import type { DerivedMediaSnapshot } from "./derived-media";
import type { DesktopProjectSession } from "./project";
import { eventChannels } from "./channels";

export interface DesktopEventContract<TPayload> {
  channel: string;
  readonly __payload?: TPayload;
}

function event<TPayload>(channel: string): DesktopEventContract<TPayload> {
  return { channel };
}

export const desktopEvents = {
  accountChanged: event<void>(eventChannels.accountChanged),
  agentsDelta: event<AgentProjectDelta>(eventChannels.agentsDelta),
  authAuthenticated: event<void>(eventChannels.authAuthenticated),
  authError: event<void>(eventChannels.authError),
  authUserUpdated: event<void>(eventChannels.authUserUpdated),
  cloudTransfersChanged: event<CloudTransferSnapshot[]>(eventChannels.cloudTransfersChanged),
  derivedChanged: event<DerivedMediaSnapshot>(eventChannels.derivedChanged),
  projectChanged: event<DesktopProjectSession>(eventChannels.projectChanged),
  transcriptsChanged: event<TranscriptSnapshot>(eventChannels.transcriptsChanged),
} as const;
