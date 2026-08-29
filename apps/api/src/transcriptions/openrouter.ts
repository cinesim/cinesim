import {
  boundedAudioStream,
  finiteNumber,
  objectValue,
  optionalString,
  readJsonResponse,
  TranscriptionGatewayError,
  type TranscriptionAudioFormat,
} from "./service";

export const OPENROUTER_TRANSCRIPTION_ENDPOINT =
  "https://openrouter.ai/api/v1/audio/transcriptions";

export interface OpenRouterTextTranscriptionInput {
  audio: ReadableStream<Uint8Array>;
  format: TranscriptionAudioFormat;
  contentType: string;
  model: string;
  language?: string | null;
  provider?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TextTranscript {
  requestId: string | null;
  model: string;
  text: string;
  language: string | null;
  durationSeconds: number | null;
  usage?: {
    seconds?: number;
    cost?: number;
  };
}

interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

function multipartField(name: string, value: string): string {
  return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

export function createOpenRouterMultipart(
  input: OpenRouterTextTranscriptionInput,
  boundary = `cinesim-${crypto.randomUUID()}`,
): MultipartBody {
  const encoder = new TextEncoder();
  const fields = [
    multipartField("model", input.model),
    ...(input.language ? [multipartField("language", input.language)] : []),
    ...(input.provider ? [multipartField("provider", JSON.stringify(input.provider))] : []),
  ]
    .map((field) => `--${boundary}\r\n${field}`)
    .join("");
  const prefix = encoder.encode(
    `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${input.format}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = boundedAudioStream(input.audio).getReader();
  let prefixSent = false;

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

export function normalizeOpenRouterTextTranscript(
  payload: unknown,
  model: string,
  generationId?: string | null,
): TextTranscript {
  const root = objectValue(payload);
  const text = optionalString(root?.text);
  if (!root || !text) {
    throw new TranscriptionGatewayError(
      "invalid_provider_response",
      "OpenRouter returned no transcript text",
    );
  }
  const usage = objectValue(root.usage);
  const seconds = finiteNumber(usage?.seconds);
  const cost = finiteNumber(usage?.cost);
  return {
    requestId: generationId ?? optionalString(root.request_id) ?? null,
    model,
    text,
    language: optionalString(root.language) ?? null,
    durationSeconds: finiteNumber(root.duration) ?? seconds,
    ...(usage
      ? {
          usage: {
            ...(seconds === null ? {} : { seconds }),
            ...(cost === null ? {} : { cost }),
          },
        }
      : {}),
  };
}

export class OpenRouterTextTranscriptionGateway {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async transcribe(input: OpenRouterTextTranscriptionInput): Promise<TextTranscript> {
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
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch (error) {
      if (error instanceof TranscriptionGatewayError) throw error;
      throw new TranscriptionGatewayError(
        "provider_unavailable",
        error instanceof Error ? error.message : "OpenRouter transcription request failed",
      );
    }
    const payload = await readJsonResponse(response, "OpenRouter");
    if (!response.ok) {
      const root = objectValue(payload);
      const nestedError = objectValue(root?.error);
      throw new TranscriptionGatewayError(
        `provider_${response.status}`,
        optionalString(root?.message) ??
          optionalString(nestedError?.message) ??
          `OpenRouter returned ${response.status}`,
        response.status >= 400 && response.status < 500 ? 400 : 502,
      );
    }
    return normalizeOpenRouterTextTranscript(
      payload,
      input.model,
      response.headers.get("x-generation-id"),
    );
  }
}
