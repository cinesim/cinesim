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

interface WordsPayload {
  owner: Record<string, unknown>;
  words: unknown[];
}

interface ObjectGraphItem {
  object: Record<string, unknown>;
  depth: number;
}

function enqueueObject(queue: ObjectGraphItem[], value: unknown, depth: number): void {
  const object = objectValue(value);
  if (object) queue.push({ object, depth });
}

function enqueueChildren(queue: ObjectGraphItem[], item: ObjectGraphItem): void {
  if (item.depth >= 6) return;
  for (const child of Object.values(item.object)) {
    if (Array.isArray(child)) {
      for (const entry of child.slice(0, 16)) enqueueObject(queue, entry, item.depth + 1);
      continue;
    }
    enqueueObject(queue, child, item.depth + 1);
  }
}

function* nestedObjects(value: unknown): Generator<Record<string, unknown>> {
  const root = objectValue(value);
  if (!root) return;
  const queue: ObjectGraphItem[] = [{ object: root, depth: 0 }];
  for (let visited = 0; queue.length > 0 && visited < 200; visited += 1) {
    const item = queue.shift();
    if (!item) return;
    yield item.object;
    enqueueChildren(queue, item);
  }
}

function documentedWordsPayload(value: unknown): WordsPayload | null {
  // Deepgram includes both the complete channel alternative word list and smaller
  // `words` arrays on each utterance. Always prefer the documented channel shape;
  // a generic breadth-first search can otherwise stop at only the first utterance.
  const root = objectValue(value);
  const results = objectValue(root?.results);
  const channels = Array.isArray(results?.channels) ? results.channels : [];
  for (const channelValue of channels) {
    const channel = objectValue(channelValue);
    const alternatives = Array.isArray(channel?.alternatives) ? channel.alternatives : [];
    for (const alternativeValue of alternatives) {
      const alternative = objectValue(alternativeValue);
      if (!alternative || !Array.isArray(alternative.words)) continue;
      return { owner: alternative, words: alternative.words };
    }
  }
  return null;
}

function hasWordTimestamps(words: readonly unknown[]): boolean {
  return words.some((word) => {
    const candidate = objectValue(word);
    return finiteNumber(candidate?.start) !== null && finiteNumber(candidate?.end) !== null;
  });
}

function wordsPayload(object: Record<string, unknown>): WordsPayload | null {
  return Array.isArray(object.words) ? { owner: object, words: object.words } : null;
}

function findWordsPayload(value: unknown): WordsPayload | null {
  const documented = documentedWordsPayload(value);
  if (documented) return documented;
  let emptyWords: WordsPayload | null = null;
  for (const object of nestedObjects(value)) {
    const candidate = wordsPayload(object);
    if (!candidate) continue;
    emptyWords ??= candidate;
    if (hasWordTimestamps(candidate.words)) return candidate;
  }
  return emptyWords;
}

function findNestedArray(value: unknown, key: string): unknown[] {
  for (const object of nestedObjects(value)) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}

function speakerName(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function normalizeWord(value: unknown): GatewayTranscriptWord | null {
  const word = objectValue(value);
  if (!word) return null;
  const startSeconds = finiteNumber(word.start);
  const endSeconds = finiteNumber(word.end);
  const text = optionalString(word.punctuated_word) ?? optionalString(word.word);
  if (startSeconds === null || endSeconds === null || !text || endSeconds <= startSeconds) {
    return null;
  }
  const confidence = finiteNumber(word.confidence);
  const speaker = speakerName(word.speaker);
  const utteranceId = optionalString(word.utterance_id);
  const detectedLanguage = optionalString(word.language) ?? optionalString(word.detected_language);
  return {
    text,
    startSeconds,
    endSeconds,
    ...(confidence === null ? {} : { confidence }),
    ...(speaker ? { speaker } : {}),
    ...(utteranceId ? { utteranceId } : {}),
    ...(detectedLanguage ? { detectedLanguage } : {}),
  };
}

function normalizeWords(words: readonly unknown[]): GatewayTranscriptWord[] {
  return words
    .flatMap((value) => normalizeWord(value) ?? [])
    .toSorted(
      (left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
    );
}

function overlappingWordIndexes(
  words: readonly GatewayTranscriptWord[],
  startSeconds: number,
  endSeconds: number,
): number[] {
  return words.flatMap((word, index) =>
    word.startSeconds < endSeconds && word.endSeconds > startSeconds ? [index] : [],
  );
}

function normalizeNativeUtterance(
  value: unknown,
  index: number,
  words: readonly GatewayTranscriptWord[],
): GatewayTranscriptUtterance | null {
  const utterance = objectValue(value);
  const startSeconds = finiteNumber(utterance?.start);
  const endSeconds = finiteNumber(utterance?.end);
  if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) return null;
  const confidence = finiteNumber(utterance?.confidence);
  const speaker = speakerName(utterance?.speaker);
  const detectedLanguage =
    optionalString(utterance?.language) ?? optionalString(utterance?.detected_language);
  return {
    id: optionalString(utterance?.id) ?? `utterance-${String(index + 1).padStart(6, "0")}`,
    startSeconds,
    endSeconds,
    ...(speaker ? { speaker } : {}),
    ...(confidence === null ? {} : { confidence }),
    ...(detectedLanguage ? { detectedLanguage } : {}),
    wordIndexes: overlappingWordIndexes(words, startSeconds, endSeconds),
  };
}

function nativeUtterances(
  payload: unknown,
  words: readonly GatewayTranscriptWord[],
): GatewayTranscriptUtterance[] {
  return findNestedArray(payload, "utterances").flatMap(
    (value, index) => normalizeNativeUtterance(value, index, words) ?? [],
  );
}

function startsNewUtterance(
  current: GatewayTranscriptUtterance | null,
  word: GatewayTranscriptWord,
): boolean {
  return (
    !current ||
    current.speaker !== word.speaker ||
    (word.utteranceId !== undefined && current.id !== word.utteranceId)
  );
}

function createInferredUtterance(
  word: GatewayTranscriptWord,
  index: number,
): GatewayTranscriptUtterance {
  return {
    id: word.utteranceId ?? `utterance-${String(index + 1).padStart(6, "0")}`,
    startSeconds: word.startSeconds,
    endSeconds: word.endSeconds,
    ...(word.speaker ? { speaker: word.speaker } : {}),
    ...(word.detectedLanguage ? { detectedLanguage: word.detectedLanguage } : {}),
    wordIndexes: [index],
  };
}

function inferredUtterances(words: readonly GatewayTranscriptWord[]): GatewayTranscriptUtterance[] {
  const utterances: GatewayTranscriptUtterance[] = [];

  let current: GatewayTranscriptUtterance | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    if (startsNewUtterance(current, word)) {
      current = createInferredUtterance(word, utterances.length);
      utterances.push(current);
      continue;
    }
    if (!current) continue;
    current.endSeconds = word.endSeconds;
    current.wordIndexes.push(index);
  }
  return utterances;
}

function normalizeUtterances(
  payload: unknown,
  words: readonly GatewayTranscriptWord[],
): GatewayTranscriptUtterance[] {
  const native = nativeUtterances(payload, words);
  return native.length > 0 ? native : inferredUtterances(words);
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
