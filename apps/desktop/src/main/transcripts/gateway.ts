import { z } from "zod";
import { TRANSCRIPTION_MODEL } from "../../shared/transcript";

export const MAX_GATEWAY_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_GATEWAY_WORDS_PER_CHUNK = 50_000;
export const MAX_GATEWAY_UTTERANCES_PER_CHUNK = 10_000;

export interface AccountTranscriptionGateway {
  authenticatedFetch(path: string, init?: RequestInit): Promise<Response>;
}

export const gatewayTranscriptSchema = z
  .object({
    requestId: z.string().max(256).nullable(),
    model: z.literal(TRANSCRIPTION_MODEL),
    text: z.string().max(2_000_000),
    language: z.string().max(32).nullable(),
    durationSeconds: z.number().nonnegative().finite().nullable(),
    confidence: z.number().min(0).max(1).optional(),
    words: z
      .array(
        z
          .object({
            text: z.string().min(1).max(1_000),
            startSeconds: z.number().nonnegative().finite(),
            endSeconds: z.number().nonnegative().finite(),
            confidence: z.number().min(0).max(1).optional(),
            speaker: z.string().min(1).max(128).optional(),
            utteranceId: z.string().min(1).max(128).optional(),
            paragraphId: z.string().min(1).max(128).optional(),
            detectedLanguage: z.string().min(1).max(32).optional(),
          })
          .strict()
          .refine((word) => word.endSeconds > word.startSeconds),
      )
      .max(MAX_GATEWAY_WORDS_PER_CHUNK),
    utterances: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            startSeconds: z.number().nonnegative().finite(),
            endSeconds: z.number().nonnegative().finite(),
            speaker: z.string().min(1).max(128).optional(),
            confidence: z.number().min(0).max(1).optional(),
            detectedLanguage: z.string().min(1).max(32).optional(),
            wordIndexes: z.array(z.number().int().nonnegative().safe()).max(100_000),
          })
          .strict()
          .refine((utterance) => utterance.endSeconds > utterance.startSeconds),
      )
      .max(MAX_GATEWAY_UTTERANCES_PER_CHUNK),
  })
  .strict();

export type GatewayTranscript = z.infer<typeof gatewayTranscriptSchema>;
export type StoredGatewayTranscript = Omit<GatewayTranscript, "text" | "model">;

export interface TranscriptionGatewayResult {
  transcript: StoredGatewayTranscript;
  responseBytes: number;
}

export class TranscriptionGateway {
  constructor(private readonly account: AccountTranscriptionGateway) {}

  async transcribe(input: {
    data: Uint8Array;
    keyterms: string[];
    durationUs: number;
    signal: AbortSignal;
  }): Promise<TranscriptionGatewayResult> {
    if (!(input.data.buffer instanceof ArrayBuffer)) {
      throw new Error("Transcription audio must use an ArrayBuffer-backed byte array");
    }
    const body =
      input.data.byteOffset === 0 && input.data.byteLength === input.data.buffer.byteLength
        ? input.data.buffer
        : input.data.buffer.slice(
            input.data.byteOffset,
            input.data.byteOffset + input.data.byteLength,
          );
    const response = await this.account.authenticatedFetch("/api/v1/transcriptions?format=wav", {
      method: "POST",
      headers: {
        "content-type": "audio/wav",
        "x-cinesim-keyterms": JSON.stringify(input.keyterms),
        "x-cinesim-audio-duration-us": String(input.durationUs),
      },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(90_000), input.signal]),
    });
    if (!response.ok) throw new Error(`Transcription gateway returned ${response.status}`);
    const { value, bytes } = await readBoundedJson(response, MAX_GATEWAY_RESPONSE_BYTES);
    const { text: _text, model: _model, ...transcript } = gatewayTranscriptSchema.parse(value);
    return { transcript, responseBytes: bytes };
  }
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<{ value: unknown; bytes: number }> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes)
    throw new Error("Transcription gateway response exceeded its size limit");
  if (!response.body) throw new Error("Transcription gateway returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Transcription gateway response exceeded its size limit");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { value: JSON.parse(new TextDecoder().decode(body)) as unknown, bytes };
}
