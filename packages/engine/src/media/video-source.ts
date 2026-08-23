import type { AssetId, TimeUs } from "@cinesim/core";

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

export type MediaSourceKind = "original" | "proxy";

export interface MediaSourceDescriptor {
  assetId: AssetId;
  kind: MediaSourceKind;
  url: string;
}

export interface MediaSourceResolver {
  resolve(assetId: AssetId): MediaSourceDescriptor;
  invalidate?(assetId?: AssetId): void;
}

export type VideoSourceFactory = (
  descriptor: MediaSourceDescriptor,
) => VideoSource & Partial<AudioSource>;

export interface AudioBufferChunk {
  buffer: AudioBuffer;
  timestampUs: TimeUs;
  durationUs: TimeUs;
}

export interface AudioSource {
  buffers(fromUs: TimeUs, toUs: TimeUs): AsyncGenerator<AudioBufferChunk>;
}
