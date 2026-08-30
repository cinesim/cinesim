import type { AssetId, TimeUs } from "@cinesim/core";
import type { SourceFingerprint } from "../contracts";
import type {
  TRANSCRIPT_ARTIFACT_VERSION,
  TRANSCRIPT_GENERATOR_VERSION,
  TRANSCRIPTION_MODEL,
} from "./constants";

export interface TranscriptGenerationOptions {
  language: string | null;
  detectLanguage: boolean;
  multilingual: boolean;
  diarization: true;
  utterances: true;
  paragraphs: true;
  smartFormat: true;
  punctuation: true;
  fillerWords: true;
  profanityFilter: false;
  redactPersonalInformation: false;
  keyterms: string[];
}

export interface TranscriptArtifactWord {
  id: string;
  text: string;
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
  confidence?: number;
  speakerClusterId?: string;
  utteranceId?: string;
  paragraphId?: string;
  detectedLanguage?: string;
}

export interface TranscriptArtifactUtterance {
  id: string;
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
  speakerClusterId?: string;
  confidence?: number;
  detectedLanguage?: string;
  wordIds: string[];
}

export interface TranscriptArtifact {
  version: typeof TRANSCRIPT_ARTIFACT_VERSION;
  assetId: AssetId;
  sourceFingerprint: SourceFingerprint;
  generator: {
    gateway: "direct";
    provider: "deepgram";
    model: typeof TRANSCRIPTION_MODEL;
    version: typeof TRANSCRIPT_GENERATOR_VERSION;
    requestId?: string;
  };
  options: TranscriptGenerationOptions;
  language: string | null;
  durationUs: TimeUs;
  confidence?: number;
  words: TranscriptArtifactWord[];
  utterances: TranscriptArtifactUtterance[];
}

export interface TranscriptAudioChunkInput {
  jobId: string;
  chunkIndex: number;
  sourceStartUs: TimeUs;
  sourceEndUs: TimeUs;
  data: Uint8Array;
}
