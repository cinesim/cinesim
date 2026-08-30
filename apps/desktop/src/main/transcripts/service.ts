import { TranscriptJobCoordinator } from "./job-coordinator";

export type {
  TranscriptAccountGateway,
  TranscriptCoordinatorDependencies,
} from "./job-coordinator";

export class TranscriptStore extends TranscriptJobCoordinator {}
