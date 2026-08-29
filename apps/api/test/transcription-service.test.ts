import { describe, expect, it } from "vite-plus/test";
import {
  createOpenRouterMultipart,
  normalizeOpenRouterTranscript,
  OpenRouterTranscriptionGateway,
} from "../src/transcriptions/service";

function audioStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("OpenRouter Nova-3 transcription gateway", () => {
  it("streams multipart audio with editing-oriented Deepgram options", async () => {
    const multipart = createOpenRouterMultipart(
      {
        audio: audioStream(new Uint8Array([1, 2, 3, 4])),
        format: "wav",
        contentType: "audio/wav",
        language: null,
        keyterms: ["Cinesim", "Mediabunny"],
      },
      "test-boundary",
    );
    const bytes = new Uint8Array(await new Response(multipart.body).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(multipart.contentType).toBe("multipart/form-data; boundary=test-boundary");
    expect(text).toContain('name="model"\r\n\r\ndeepgram/nova-3');
    expect(text).toContain('name="file"; filename="audio.wav"');
    expect(text).toContain('"diarize":true');
    expect(text).toContain('"utterances":true');
    expect(text).toContain('"paragraphs":true');
    expect(text).toContain('"smart_format":true');
    expect(text).toContain('"filler_words":true');
    expect(text).toContain('"language":"multi"');
    expect(text).toContain('"keyterm":["Cinesim","Mediabunny"]');
    expect([...bytes]).toContain(1);
    expect([...bytes]).toContain(4);
  });

  it("normalizes native Deepgram words, speakers, language, and utterances", () => {
    const transcript = normalizeOpenRouterTranscript(
      {
        metadata: { request_id: "deepgram-request", duration: 2.5 },
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "Hello, world.",
                  confidence: 0.97,
                  detected_language: "en",
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
                  utterances: [
                    { id: "utt-0", start: 0.2, end: 0.7, speaker: 0, confidence: 0.99 },
                    { id: "utt-1", start: 1, end: 1.5, speaker: 1, confidence: 0.96 },
                  ],
                },
              ],
            },
          ],
        },
        usage: { seconds: 2.5, cost: 0.0002 },
      },
      "generation-id",
    );

    expect(transcript).toMatchObject({
      requestId: "generation-id",
      model: "deepgram/nova-3",
      text: "Hello, world.",
      language: "en",
      durationSeconds: 2.5,
      confidence: 0.97,
      usage: { seconds: 2.5, cost: 0.0002 },
    });
    expect(transcript.words).toEqual([
      expect.objectContaining({ text: "Hello,", speaker: "0", startSeconds: 0.2 }),
      expect.objectContaining({ text: "world.", speaker: "1", endSeconds: 1.5 }),
    ]);
    expect(transcript.utterances).toEqual([
      expect.objectContaining({ id: "utt-0", speaker: "0", wordIndexes: [0] }),
      expect.objectContaining({ id: "utt-1", speaker: "1", wordIndexes: [1] }),
    ]);
  });

  it("normalizes OpenAI-compatible verbose word timestamps", () => {
    const transcript = normalizeOpenRouterTranscript({
      text: "A test",
      language: "en",
      duration: 1.2,
      words: [
        { word: "A", start: 0, end: 0.2 },
        { word: "test", start: 0.3, end: 0.8 },
      ],
    });
    expect(transcript.words).toHaveLength(2);
    expect(transcript.utterances).toEqual([
      expect.objectContaining({ startSeconds: 0, endSeconds: 0.8, wordIndexes: [0, 1] }),
    ]);
  });

  it("fails visibly when a provider strips timestamps", () => {
    expect(() => normalizeOpenRouterTranscript({ text: "Untimed transcript" })).toThrow(
      /word timestamps required/,
    );
  });

  it("keeps the API key server-side while forwarding streamed audio", async () => {
    let requestBody = "";
    const mockFetch: typeof fetch = async (_input, init) => {
      requestBody = await new Response(init?.body).text();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
      return new Response(
        JSON.stringify({
          text: "Hello",
          language: "en",
          words: [{ word: "Hello", start: 0, end: 0.5, confidence: 0.9 }],
          usage: { seconds: 0.5 },
        }),
        { status: 200, headers: { "content-type": "application/json", "x-generation-id": "g-1" } },
      );
    };
    const gateway = new OpenRouterTranscriptionGateway("secret-key", mockFetch);
    const result = await gateway.transcribe({
      audio: audioStream(new TextEncoder().encode("audio-data")),
      format: "wav",
      contentType: "audio/wav",
      language: "en",
      keyterms: [],
    });
    expect(requestBody).toContain("audio-data");
    expect(requestBody).not.toContain("secret-key");
    expect(result.requestId).toBe("g-1");
  });
});
