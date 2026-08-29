export const TRANSCRIPTION_MODEL = "deepgram/nova-3" as const;
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 24 * 1024 * 1024;
export const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024 * 1024;

export type TranscriptionAudioFormat = "wav" | "mp3" | "flac" | "m4a" | "ogg" | "webm" | "aac";

export interface TranscriptionGatewayInput {
  audio: ReadableStream<Uint8Array>;
  format: TranscriptionAudioFormat;
  contentType: string;
  language: string | null;
  keyterms: string[];
  signal?: AbortSignal;
}

export interface GatewayTranscriptWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
  speaker?: string;
  utteranceId?: string;
  paragraphId?: string;
  detectedLanguage?: string;
}

export interface GatewayTranscriptUtterance {
  id: string;
  startSeconds: number;
  endSeconds: number;
  speaker?: string;
  confidence?: number;
  detectedLanguage?: string;
  wordIndexes: number[];
}

export interface GatewayTranscript {
  requestId: string | null;
  model: typeof TRANSCRIPTION_MODEL;
  text: string;
  language: string | null;
  durationSeconds: number | null;
  confidence?: number;
  words: GatewayTranscriptWord[];
  utterances: GatewayTranscriptUtterance[];
  usage?: {
    seconds?: number;
    cost?: number;
  };
}

export interface EditingTranscriptionGateway {
  transcribe(input: TranscriptionGatewayInput): Promise<GatewayTranscript>;
}

export class TranscriptionGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "TranscriptionGatewayError";
  }
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function boundedAudioStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let audioBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      audioBytes += next.value.byteLength;
      if (audioBytes > MAX_TRANSCRIPTION_AUDIO_BYTES) {
        await reader.cancel("audio_too_large");
        controller.error(
          new TranscriptionGatewayError(
            "audio_too_large",
            "Transcription audio chunks must be smaller than 24 MiB",
            413,
          ),
        );
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export async function readJsonResponse(response: Response, provider: string): Promise<unknown> {
  const declaredBytes = Number(response.headers.get("content-length") ?? "0");
  if (declaredBytes > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
    throw new TranscriptionGatewayError(
      "provider_response_too_large",
      `${provider} returned an unexpectedly large transcript`,
    );
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    receivedBytes += next.value.byteLength;
    if (receivedBytes > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
      await reader.cancel("provider_response_too_large");
      throw new TranscriptionGatewayError(
        "provider_response_too_large",
        `${provider} returned an unexpectedly large transcript`,
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function findWordsPayload(
  value: unknown,
): { owner: Record<string, unknown>; words: unknown[] } | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let emptyWords: { owner: Record<string, unknown>; words: unknown[] } | null = null;
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const item = queue.shift();
    if (!item) break;
    visited += 1;
    const object = objectValue(item.value);
    if (!object) continue;
    const words = object.words;
    if (Array.isArray(words) && !emptyWords) emptyWords = { owner: object, words };
    if (
      Array.isArray(words) &&
      words.some((word) => {
        const candidate = objectValue(word);
        return finiteNumber(candidate?.start) !== null && finiteNumber(candidate?.end) !== null;
      })
    ) {
      return { owner: object, words };
    }
    if (item.depth >= 6) continue;
    for (const child of Object.values(object)) {
      if (Array.isArray(child)) {
        for (const entry of child.slice(0, 16)) queue.push({ value: entry, depth: item.depth + 1 });
      } else if (objectValue(child)) {
        queue.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return emptyWords;
}

function findNestedArray(value: unknown, key: string): unknown[] {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const item = queue.shift();
    if (!item) break;
    visited += 1;
    const object = objectValue(item.value);
    if (!object) continue;
    if (Array.isArray(object[key])) return object[key] as unknown[];
    if (item.depth >= 6) continue;
    for (const child of Object.values(object)) {
      if (Array.isArray(child)) {
        for (const entry of child.slice(0, 16)) queue.push({ value: entry, depth: item.depth + 1 });
      } else if (objectValue(child)) {
        queue.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return [];
}

function normalizeWords(words: readonly unknown[]): GatewayTranscriptWord[] {
  const normalized: GatewayTranscriptWord[] = [];
  for (const value of words) {
    const word = objectValue(value);
    if (!word) continue;
    const startSeconds = finiteNumber(word.start);
    const endSeconds = finiteNumber(word.end);
    const text = optionalString(word.punctuated_word) ?? optionalString(word.word);
    if (startSeconds === null || endSeconds === null || !text || endSeconds <= startSeconds)
      continue;
    const confidence = finiteNumber(word.confidence);
    const speakerValue = word.speaker;
    const utteranceId = optionalString(word.utterance_id);
    const detectedLanguage =
      optionalString(word.language) ?? optionalString(word.detected_language);
    normalized.push({
      text,
      startSeconds,
      endSeconds,
      ...(confidence === null ? {} : { confidence }),
      ...(typeof speakerValue === "number" || typeof speakerValue === "string"
        ? { speaker: String(speakerValue) }
        : {}),
      ...(utteranceId ? { utteranceId } : {}),
      ...(detectedLanguage ? { detectedLanguage } : {}),
    });
  }
  return normalized.sort(
    (left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  );
}

function normalizeUtterances(
  payload: unknown,
  words: readonly GatewayTranscriptWord[],
): GatewayTranscriptUtterance[] {
  const raw = findNestedArray(payload, "utterances");
  const utterances: GatewayTranscriptUtterance[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = objectValue(raw[index]);
    const startSeconds = finiteNumber(value?.start);
    const endSeconds = finiteNumber(value?.end);
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) continue;
    const speaker = value?.speaker;
    const confidence = finiteNumber(value?.confidence);
    const detectedLanguage =
      optionalString(value?.language) ?? optionalString(value?.detected_language);
    utterances.push({
      id: optionalString(value?.id) ?? `utterance-${String(index + 1).padStart(6, "0")}`,
      startSeconds,
      endSeconds,
      ...(typeof speaker === "number" || typeof speaker === "string"
        ? { speaker: String(speaker) }
        : {}),
      ...(confidence === null ? {} : { confidence }),
      ...(detectedLanguage ? { detectedLanguage } : {}),
      wordIndexes: words.flatMap((word, wordIndex) =>
        word.startSeconds < endSeconds && word.endSeconds > startSeconds ? [wordIndex] : [],
      ),
    });
  }
  if (utterances.length > 0) return utterances;

  let current: GatewayTranscriptUtterance | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    if (
      !current ||
      current.speaker !== word.speaker ||
      (word.utteranceId !== undefined && current.id !== word.utteranceId)
    ) {
      current = {
        id: word.utteranceId ?? `utterance-${String(utterances.length + 1).padStart(6, "0")}`,
        startSeconds: word.startSeconds,
        endSeconds: word.endSeconds,
        ...(word.speaker ? { speaker: word.speaker } : {}),
        ...(word.detectedLanguage ? { detectedLanguage: word.detectedLanguage } : {}),
        wordIndexes: [index],
      };
      utterances.push(current);
    } else {
      current.endSeconds = word.endSeconds;
      current.wordIndexes.push(index);
    }
  }
  return utterances;
}

function assignParagraphs(
  payload: unknown,
  words: readonly GatewayTranscriptWord[],
): GatewayTranscriptWord[] {
  const raw = findNestedArray(payload, "paragraphs");
  const ranges = raw.flatMap((value, index) => {
    const paragraph = objectValue(value);
    const startSeconds = finiteNumber(paragraph?.start);
    const endSeconds = finiteNumber(paragraph?.end);
    return startSeconds !== null && endSeconds !== null && endSeconds > startSeconds
      ? [{ id: `paragraph-${String(index + 1).padStart(6, "0")}`, startSeconds, endSeconds }]
      : [];
  });
  if (ranges.length === 0) return [...words];
  return words.map((word) => {
    const midpoint = word.startSeconds + (word.endSeconds - word.startSeconds) / 2;
    const paragraph = ranges.find(
      (candidate) => midpoint >= candidate.startSeconds && midpoint <= candidate.endSeconds,
    );
    return paragraph ? { ...word, paragraphId: paragraph.id } : word;
  });
}

export function normalizeDeepgramTranscript(payload: unknown): GatewayTranscript {
  const root = objectValue(payload);
  if (!root) {
    throw new TranscriptionGatewayError(
      "invalid_provider_response",
      "Deepgram returned invalid JSON",
    );
  }
  const timed = findWordsPayload(root);
  if (!timed) {
    throw new TranscriptionGatewayError(
      "word_timestamps_unavailable",
      "Deepgram Nova-3 returned no word timestamps for transcript editing",
    );
  }
  const words = assignParagraphs(root, normalizeWords(timed.words));
  const nativeText = typeof timed.owner.transcript === "string" ? timed.owner.transcript : "";
  if (words.length === 0 && nativeText.trim().length > 0) {
    throw new TranscriptionGatewayError(
      "word_timestamps_unavailable",
      "Deepgram Nova-3 returned no usable word timestamps",
    );
  }
  const metadata = objectValue(root.metadata);
  const text = nativeText || words.map((word) => word.text).join(" ");
  const language =
    optionalString(timed.owner.detected_language) ??
    words.find((word) => word.detectedLanguage)?.detectedLanguage ??
    null;
  const durationSeconds = finiteNumber(metadata?.duration) ?? words.at(-1)?.endSeconds ?? null;
  const confidence = finiteNumber(timed.owner.confidence);
  return {
    requestId: optionalString(metadata?.request_id) ?? null,
    model: TRANSCRIPTION_MODEL,
    text,
    language,
    durationSeconds,
    ...(confidence === null ? {} : { confidence }),
    words,
    utterances: normalizeUtterances(root, words),
  };
}
