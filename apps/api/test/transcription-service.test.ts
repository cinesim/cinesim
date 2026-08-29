import { describe, expect, it, vi } from "vite-plus/test";
import {
  createDeepgramTranscriptionUrl,
  DeepgramTranscriptionGateway,
} from "../src/transcriptions/deepgram";
import {
  createOpenRouterMultipart,
  normalizeOpenRouterTextTranscript,
  OpenRouterTextTranscriptionGateway,
} from "../src/transcriptions/openrouter";
import {
  normalizeDeepgramTranscript,
  type TranscriptionGatewayInput,
} from "../src/transcriptions/service";

function audioStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function editingInput(): TranscriptionGatewayInput {
  return {
    audio: audioStream(new Uint8Array([1, 2, 3, 4])),
    format: "wav",
    contentType: "audio/wav",
    language: null,
    keyterms: ["Cinesim", "Mediabunny"],
  };
}

function deepgramResponse(): Record<string, unknown> {
  return {
    metadata: { request_id: "deepgram-request", duration: 2.5 },
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: "Hello, world.",
              confidence: 0.97,
              detected_language: "en",
              paragraphs: {
                paragraphs: [{ start: 0.2, end: 1.5, num_words: 2 }],
              },
              words: [
                {
                  word: "hello",
                  punctuated_word: "Hello,",
                  start: 0.2,
                  end: 0.7,
                  confidence: 0.99,
                  speaker: 0,
                },
                {
                  word: "world",
                  punctuated_word: "world.",
                  start: 1,
                  end: 1.5,
                  confidence: 0.96,
                  speaker: 1,
                },
              ],
            },
          ],
        },
      ],
      utterances: [
        {
          id: "utt-0",
          start: 0.2,
          end: 0.7,
          speaker: 0,
          confidence: 0.99,
          words: [
            {
              word: "hello",
              punctuated_word: "Hello,",
              start: 0.2,
              end: 0.7,
              confidence: 0.99,
              speaker: 0,
            },
          ],
        },
        {
          id: "utt-1",
          start: 1,
          end: 1.5,
          speaker: 1,
          confidence: 0.96,
          words: [
            {
              word: "world",
              punctuated_word: "world.",
              start: 1,
              end: 1.5,
              confidence: 0.96,
              speaker: 1,
            },
          ],
        },
      ],
    },
  };
}

describe("direct Deepgram Nova-3 transcription gateway", () => {
  it("requests editing-oriented Nova-3 features and repeated keyterms", () => {
    const url = createDeepgramTranscriptionUrl(editingInput());

    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("diarize_model")).toBe("latest");
    expect(url.searchParams.get("utterances")).toBe("true");
    expect(url.searchParams.get("paragraphs")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("filler_words")).toBe("true");
    expect(url.searchParams.get("language")).toBe("multi");
    expect(url.searchParams.get("mip_opt_out")).toBe("true");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Cinesim", "Mediabunny"]);
  });

  it("normalizes native words, speakers, language, and top-level utterances", () => {
    const transcript = normalizeDeepgramTranscript(deepgramResponse());

    expect(transcript).toMatchObject({
      requestId: "deepgram-request",
      model: "deepgram/nova-3",
      text: "Hello, world.",
      language: "en",
      durationSeconds: 2.5,
      confidence: 0.97,
    });
    expect(transcript.words).toEqual([
      expect.objectContaining({
        text: "Hello,",
        speaker: "0",
        paragraphId: "paragraph-000001",
        startSeconds: 0.2,
      }),
      expect.objectContaining({
        text: "world.",
        speaker: "1",
        paragraphId: "paragraph-000001",
        endSeconds: 1.5,
      }),
    ]);
    expect(transcript.utterances).toEqual([
      expect.objectContaining({ id: "utt-0", speaker: "0", wordIndexes: [0] }),
      expect.objectContaining({ id: "utt-1", speaker: "1", wordIndexes: [1] }),
    ]);
  });

  it("prefers the complete channel words over an utterance's partial word list", () => {
    const transcript = normalizeDeepgramTranscript(deepgramResponse());

    expect(transcript.text).toBe("Hello, world.");
    expect(transcript.words.map((word) => word.text)).toEqual(["Hello,", "world."]);
  });

  it("streams raw audio with the Deepgram key only in the authorization header", async () => {
    let requestBody = "";
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      requestBody = await new Response(init?.body).text();
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Token secret-key");
      expect(headers.get("content-type")).toBe("audio/wav");
      return new Response(JSON.stringify(deepgramResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const gateway = new DeepgramTranscriptionGateway("secret-key", mockFetch);

    const result = await gateway.transcribe(editingInput());

    expect(requestBody).toBe(String.fromCharCode(1, 2, 3, 4));
    expect(requestBody).not.toContain("secret-key");
    expect(result.requestId).toBe("deepgram-request");
  });

  it("fails visibly if Deepgram ever omits native word timings", () => {
    expect(() =>
      normalizeDeepgramTranscript({
        results: {
          channels: [{ alternatives: [{ transcript: "Untimed transcript", words: [] }] }],
        },
      }),
    ).toThrow(/no usable word timestamps/);
  });

  it("accepts a native empty-word response for a silent audio chunk", () => {
    expect(
      normalizeDeepgramTranscript({
        metadata: { request_id: "silent", duration: 30 },
        results: { channels: [{ alternatives: [{ transcript: "", words: [] }] }] },
      }),
    ).toMatchObject({ requestId: "silent", text: "", durationSeconds: 30, words: [] });
  });
});

describe("general OpenRouter text transcription gateway", () => {
  it("streams multipart audio for any selected text transcription model", async () => {
    const multipart = createOpenRouterMultipart(
      {
        audio: audioStream(new Uint8Array([1, 2, 3, 4])),
        format: "wav",
        contentType: "audio/wav",
        model: "vendor/text-transcriber",
        language: "en",
        provider: { options: { vendor: { prompt: "Cinesim" } } },
      },
      "test-boundary",
    );
    const bytes = new Uint8Array(await new Response(multipart.body).arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain('name="model"\r\n\r\nvendor/text-transcriber');
    expect(text).toContain('name="file"; filename="audio.wav"');
    expect(text).toContain('name="language"\r\n\r\nen');
    expect(text).toContain('"prompt":"Cinesim"');
    expect([...bytes]).toContain(1);
    expect([...bytes]).toContain(4);
  });

  it("accepts the documented text-only response without inventing word timings", () => {
    expect(
      normalizeOpenRouterTextTranscript(
        { text: "A general transcript", usage: { seconds: 1.2, cost: 0.0002 } },
        "vendor/text-transcriber",
        "generation-id",
      ),
    ).toEqual({
      requestId: "generation-id",
      model: "vendor/text-transcriber",
      text: "A general transcript",
      language: null,
      durationSeconds: 1.2,
      usage: { seconds: 1.2, cost: 0.0002 },
    });
  });

  it("keeps the OpenRouter API key server-side", async () => {
    let requestBody = "";
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      requestBody = await new Response(init?.body).text();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
      return new Response(JSON.stringify({ text: "Hello", usage: { seconds: 0.5 } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-generation-id": "g-1" },
      });
    });
    const gateway = new OpenRouterTextTranscriptionGateway("secret-key", mockFetch);
    const result = await gateway.transcribe({
      audio: audioStream(new TextEncoder().encode("audio-data")),
      format: "wav",
      contentType: "audio/wav",
      model: "vendor/text-transcriber",
    });

    expect(requestBody).toContain("audio-data");
    expect(requestBody).not.toContain("secret-key");
    expect(result.requestId).toBe("g-1");
  });
});
