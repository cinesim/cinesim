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
  /**
   * Decodes presentation-order frames beginning at `fromUs`. Implementations may
   * decode a small bounded window ahead. Playback uses this optional path only
   * while source time is moving forward; random access continues through
   * `getFrame`.
   */
  frames?(fromUs: TimeUs, toUs?: TimeUs): AsyncGenerator<VideoFrame>;
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
  /** Resolve the canonical source for operations that explicitly require the original bytes. */
  resolveOriginal(assetId: AssetId): MediaSourceDescriptor;
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
