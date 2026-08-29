export const OPENROUTER_TRANSCRIPTION_ENDPOINT =
  "https://openrouter.ai/api/v1/audio/transcriptions";
export const OPENROUTER_TRANSCRIPTION_MODEL = "deepgram/nova-3";
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024 * 1024;

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
  model: typeof OPENROUTER_TRANSCRIPTION_MODEL;
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

interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

function multipartField(name: string, value: string): string {
  return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

export function createOpenRouterMultipart(
  input: TranscriptionGatewayInput,
  boundary = `cinesim-${crypto.randomUUID()}`,
): MultipartBody {
  const encoder = new TextEncoder();
  const providerOptions = {
    options: {
      deepgram: {
        model: "nova-3",
        diarize: true,
        utterances: true,
        paragraphs: true,
        smart_format: true,
        punctuate: true,
        filler_words: true,
        profanity_filter: false,
        redact: false,
        detect_language: input.language === null,
        ...(input.language === null ? { language: "multi" } : { language: input.language }),
        ...(input.keyterms.length > 0 ? { keyterm: input.keyterms } : {}),
      },
    },
  };
  const fields = [
    multipartField("model", OPENROUTER_TRANSCRIPTION_MODEL),
    ...(input.language ? [multipartField("language", input.language)] : []),
    multipartField("provider", JSON.stringify(providerOptions)),
  ]
    .map((field) => `--${boundary}\r\n${field}`)
    .join("");
  const prefix = encoder.encode(
    `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${input.format}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = input.audio.getReader();
  let prefixSent = false;
  let audioBytes = 0;

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!prefixSent) {
          prefixSent = true;
          controller.enqueue(prefix);
          return;
        }
        const next = await reader.read();
        if (!next.done) {
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
          return;
        }
        controller.enqueue(suffix);
        controller.close();
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    }),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findTimedWords(
  value: unknown,
): { owner: Record<string, unknown>; words: unknown[] } | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const item = queue.shift();
    if (!item) break;
    visited += 1;
    const object = objectValue(item.value);
    if (!object) continue;
    const words = object.words;
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
  return null;
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
  payload: Record<string, unknown>,
  words: readonly GatewayTranscriptWord[],
): GatewayTranscriptUtterance[] {
  const raw = Array.isArray(payload.utterances) ? payload.utterances : [];
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

export function normalizeOpenRouterTranscript(
  payload: unknown,
  generationId?: string | null,
): GatewayTranscript {
  const root = objectValue(payload);
  if (!root) {
    throw new TranscriptionGatewayError(
      "invalid_provider_response",
      "OpenRouter returned invalid JSON",
    );
  }
  const timed = findTimedWords(root);
  if (!timed) {
    throw new TranscriptionGatewayError(
      "word_timestamps_unavailable",
      "Nova-3 returned text without the word timestamps required for transcript editing",
    );
  }
  const words = normalizeWords(timed.words);
  if (words.length === 0) {
    throw new TranscriptionGatewayError(
      "word_timestamps_unavailable",
      "Nova-3 returned no usable word timestamps",
    );
  }
  const metadata = objectValue(root.metadata);
  const usage = objectValue(root.usage);
  const text =
    optionalString(root.text) ??
    optionalString(timed.owner.transcript) ??
    words.map((word) => word.text).join(" ");
  const language =
    optionalString(root.language) ??
    optionalString(timed.owner.detected_language) ??
    optionalString(metadata?.language) ??
    words.find((word) => word.detectedLanguage)?.detectedLanguage ??
    null;
  const durationSeconds =
    finiteNumber(root.duration) ??
    finiteNumber(metadata?.duration) ??
    finiteNumber(usage?.seconds) ??
    words.at(-1)?.endSeconds ??
    null;
  const confidence = finiteNumber(timed.owner.confidence);
  return {
    requestId:
      generationId ??
      optionalString(metadata?.request_id) ??
      optionalString(root.request_id) ??
      null,
    model: OPENROUTER_TRANSCRIPTION_MODEL,
    text,
    language,
    durationSeconds,
    ...(confidence === null ? {} : { confidence }),
    words,
    utterances: normalizeUtterances(timed.owner, words),
    ...(usage
      ? {
          usage: {
            ...(finiteNumber(usage.seconds) === null
              ? {}
              : { seconds: finiteNumber(usage.seconds)! }),
            ...(finiteNumber(usage.cost) === null ? {} : { cost: finiteNumber(usage.cost)! }),
          },
        }
      : {}),
  };
}

export class OpenRouterTranscriptionGateway {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async transcribe(input: TranscriptionGatewayInput): Promise<GatewayTranscript> {
    const multipart = createOpenRouterMultipart(input);
    const timeout = AbortSignal.timeout(75_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImplementation(OPENROUTER_TRANSCRIPTION_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": multipart.contentType,
          "http-referer": "https://cinesim.build",
          "x-title": "Cinesim",
        },
        body: multipart.body,
        signal,
        // Required by Node's fetch when the request body is a stream.
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch (error) {
      if (error instanceof TranscriptionGatewayError) throw error;
      throw new TranscriptionGatewayError(
        "provider_unavailable",
        error instanceof Error ? error.message : "OpenRouter transcription request failed",
      );
    }
    const responseBytes = Number(response.headers.get("content-length") ?? "0");
    if (responseBytes > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
      throw new TranscriptionGatewayError(
        "provider_response_too_large",
        "OpenRouter returned an unexpectedly large transcript",
      );
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message = optionalString(objectValue(payload)?.message);
      const nestedError = objectValue(objectValue(payload)?.error);
      throw new TranscriptionGatewayError(
        `provider_${response.status}`,
        message ?? optionalString(nestedError?.message) ?? `OpenRouter returned ${response.status}`,
        response.status >= 400 && response.status < 500 ? 400 : 502,
      );
    }
    return normalizeOpenRouterTranscript(payload, response.headers.get("x-generation-id"));
  }
}
