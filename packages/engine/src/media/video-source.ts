import type { TimeUs } from "@cinesim/core";

export interface VideoSourceMetadata {
  durationUs: TimeUs;
  width: number;
  height: number;
  frameRate: number | null;
  hasAudio: boolean;
}

export interface VideoSource {
  prepare(): Promise<VideoSourceMetadata>;
  seek(timeUs: TimeUs): Promise<void>;
  getFrame(timeUs: TimeUs): Promise<VideoFrame | null>;
  destroy(): void;
}

export interface AudioBufferChunk {
  buffer: AudioBuffer;
  timestampUs: TimeUs;
  durationUs: TimeUs;
}

export interface AudioSource {
  buffers(fromUs: TimeUs, toUs: TimeUs): AsyncGenerator<AudioBufferChunk>;
}
