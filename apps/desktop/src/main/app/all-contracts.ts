import { accountContracts } from "../account/contracts";
import { agentContracts } from "../agents/contracts";
import { cloudContracts } from "../cloud/contracts";
import { derivedContracts } from "../derived-media/contracts";
import { frameContracts } from "../frames/contracts";
import { projectContracts } from "../projects/contracts";
import { transcriptContracts } from "../transcripts/contracts";
import { visualIndexContracts } from "../visual-index/contracts";
import { appContracts } from "./contracts";
import type { InvokeContract } from "./ipc-contract";

function values<T extends Record<string, InvokeContract<unknown[], unknown>>>(contracts: T) {
  return Object.values(contracts);
}

export const allInvokeContracts = Object.freeze([
  ...values(accountContracts),
  ...values(agentContracts),
  ...values(appContracts),
  ...values(cloudContracts),
  ...values(derivedContracts),
  ...values(frameContracts),
  ...values(projectContracts),
  ...values(transcriptContracts),
  ...values(visualIndexContracts),
]);
