import {
  boundedAudioStream,
  type EditingTranscriptionGateway,
  type GatewayTranscript,
  normalizeDeepgramTranscript,
  objectValue,
  optionalString,
  readJsonResponse,
  TranscriptionGatewayError,
  type TranscriptionGatewayInput,
} from "./service";

export const DEEPGRAM_TRANSCRIPTION_ENDPOINT = "https://api.deepgram.com/v1/listen";

export function createDeepgramTranscriptionUrl(input: TranscriptionGatewayInput): URL {
  const url = new URL(DEEPGRAM_TRANSCRIPTION_ENDPOINT);
  const parameters: Array<[string, string]> = [
    ["model", "nova-3"],
    ["diarize_model", "latest"],
    ["utterances", "true"],
    ["paragraphs", "true"],
    ["smart_format", "true"],
    ["punctuate", "true"],
    ["filler_words", "true"],
    ["profanity_filter", "false"],
    ["mip_opt_out", "true"],
    ["language", input.language ?? "multi"],
  ];
  for (const [key, value] of parameters) url.searchParams.append(key, value);
  for (const keyterm of input.keyterms) url.searchParams.append("keyterm", keyterm);
  return url;
}

async function requestDeepgram(
  fetchImplementation: typeof fetch,
  apiKey: string,
  timeoutMs: number,
  input: TranscriptionGatewayInput,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    return await fetchImplementation(createDeepgramTranscriptionUrl(input), {
      method: "POST",
      headers: {
        authorization: `Token ${apiKey}`,
        "content-type": input.contentType,
      },
      body: boundedAudioStream(input.audio),
      signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (error) {
    if (error instanceof TranscriptionGatewayError) throw error;
    throw new TranscriptionGatewayError(
      "provider_unavailable",
      error instanceof Error ? error.message : "Deepgram transcription request failed",
    );
  }
}

function deepgramResponseError(response: Response, payload: unknown): TranscriptionGatewayError {
  const root = objectValue(payload);
  const nestedError = objectValue(root?.error);
  const requestId = optionalString(root?.request_id) ?? response.headers.get("dg-request-id");
  const message =
    optionalString(root?.err_msg) ??
    optionalString(root?.message) ??
    optionalString(nestedError?.message) ??
    `Deepgram returned ${response.status}`;
  return new TranscriptionGatewayError(
    `provider_${response.status}`,
    requestId ? `${message} (Deepgram request ${requestId})` : message,
    response.status >= 400 && response.status < 500 ? 400 : 502,
  );
}

export class DeepgramTranscriptionGateway implements EditingTranscriptionGateway {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = 75_000,
  ) {}

  async transcribe(input: TranscriptionGatewayInput): Promise<GatewayTranscript> {
    const response = await requestDeepgram(
      this.fetchImplementation,
      this.apiKey,
      this.timeoutMs,
      input,
    );
    const payload = await readJsonResponse(response, "Deepgram");
    if (!response.ok) throw deepgramResponseError(response, payload);
    return normalizeDeepgramTranscript(payload);
  }
}
