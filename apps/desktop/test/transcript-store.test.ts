import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { timeUs } from "@cinesim/core";
import type { Asset } from "@cinesim/core";
import { applyCommand, createProject } from "../../../packages/core/test/project-fixtures";
import type { DerivedProjectScope, SourceFingerprint } from "../src/shared/contracts";
import { parseTranscriptArtifact } from "../src/main/transcripts/artifact";
import { TranscriptChunkRepository } from "../src/main/transcripts/chunk-repository";
import { MAX_GATEWAY_RESPONSE_BYTES } from "../src/main/transcripts/gateway";
import { TranscriptStore } from "../src/main/transcripts/service";

const directories: string[] = [];
const scope: DerivedProjectScope = {
  cacheKey: "0123456789abcdef01234567",
  epoch: "123e4567-e89b-12d3-a456-426614174000",
};
const fingerprint: SourceFingerprint = {
  size: 1_024,
  mtimeMs: 42,
  edgeHash: "a".repeat(64),
};
const asset: Asset = {
  id: "asset_dialogue",
  kind: "audio",
  name: "Interview with María.wav",
  source: { kind: "local", path: "/media/interview.wav" },
  durationUs: timeUs(10_000_000),
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cinesim-transcript-test-"));
  directories.push(directory);
  await mkdir(join(directory, ".video", "transcripts"), { recursive: true });
  return directory;
}

function fixtureProject() {
  return applyCommand(createProject({ name: "Oral history" }), {
    type: "asset.import",
    asset,
  }).project;
}

function gatewayResponse(input: {
  requestId: string;
  text: string;
  start: number;
  end: number;
  speaker: string;
}) {
  return {
    requestId: input.requestId,
    model: "deepgram/nova-3",
    text: input.text,
    language: "en",
    durationSeconds: 5,
    confidence: 0.95,
    words: [
      {
        text: input.text,
        startSeconds: input.start,
        endSeconds: input.end,
        confidence: 0.95,
        speaker: input.speaker,
        detectedLanguage: "en",
      },
    ],
    utterances: [
      {
        id: `provider-${input.requestId}`,
        startSeconds: input.start,
        endSeconds: input.end,
        speaker: input.speaker,
        confidence: 0.95,
        detectedLanguage: "en",
        wordIndexes: [0],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function accountWith(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  return {
    requireCachedUser: () => ({ id: "user-1" }),
    authenticatedFetch: fetch,
  };
}

function oneChunkResponse() {
  return gatewayResponse({
    requestId: "request-one",
    text: "Complete.",
    start: 0.5,
    end: 1,
    speaker: "0",
  });
}

async function preparedStore(
  directory: string,
  account: ReturnType<typeof accountWith>,
  dependencies: ConstructorParameters<typeof TranscriptStore>[2] = {},
) {
  const store = new TranscriptStore(account, async () => fingerprint, dependencies);
  await store.setProject(directory, fixtureProject(), scope);
  await store.requestJobs(scope, [asset.id]);
  const { jobId } = await store.beginJob(scope, asset.id);
  return { store, jobId };
}

function completeChunk(jobId: string) {
  return {
    jobId,
    chunkIndex: 0,
    sourceStartUs: timeUs(0),
    sourceEndUs: asset.durationUs,
    data: new Uint8Array([1, 2, 3]),
  };
}

describe("transcript artifact store", () => {
  it("stitches bounded Nova-3 chunks into one validated fingerprint-bound artifact", async () => {
    const directory = await fixtureDirectory();
    const responses = [
      gatewayResponse({ requestId: "request-a", text: "Hello,", start: 0.5, end: 1, speaker: "0" }),
      gatewayResponse({
        requestId: "request-b",
        text: "world.",
        start: 0.25,
        end: 0.8,
        speaker: "1",
      }),
    ];
    const account = {
      requireCachedUser: () => ({ id: "user-1" }),
      authenticatedFetch: async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    };
    const store = new TranscriptStore(account, async () => fingerprint);
    await store.setProject(directory, fixtureProject(), scope);
    await store.requestJobs(scope, [asset.id]);
    const { jobId } = await store.beginJob(scope, asset.id);

    await store.transcribeChunk(scope, {
      jobId,
      chunkIndex: 0,
      sourceStartUs: timeUs(0),
      sourceEndUs: timeUs(5_000_000),
      data: new Uint8Array([1, 2, 3]),
    });
    await store.transcribeChunk(scope, {
      jobId,
      chunkIndex: 1,
      sourceStartUs: timeUs(5_000_000),
      sourceEndUs: timeUs(10_000_000),
      data: new Uint8Array([4, 5, 6]),
    });
    const snapshot = await store.finalizeJob(scope, jobId);

    expect(snapshot.assets[asset.id]).toMatchObject({ state: "ready" });
    expect(snapshot.assets[asset.id]?.artifact).toMatchObject({
      assetId: asset.id,
      sourceFingerprint: fingerprint,
      language: "en",
      generator: {
        gateway: "direct",
        provider: "deepgram",
        model: "deepgram/nova-3",
        requestId: "request-a,request-b",
      },
      options: {
        diarization: true,
        utterances: true,
        smartFormat: true,
        fillerWords: true,
        keyterms: ["Oral history", "Interview with María.wav"],
      },
      words: [
        {
          id: "word_000001",
          text: "Hello,",
          sourceStartUs: timeUs(500_000),
          sourceEndUs: timeUs(1_000_000),
          speakerClusterId: "speaker-0",
          utteranceId: "utterance_000001",
        },
        {
          id: "word_000002",
          text: "world.",
          sourceStartUs: timeUs(5_250_000),
          sourceEndUs: timeUs(5_800_000),
          speakerClusterId: "speaker-1",
          utteranceId: "utterance_000002",
        },
      ],
    });
    const saved = parseTranscriptArtifact(
      JSON.parse(
        await readFile(join(directory, ".video", "transcripts", `${asset.id}.json`), "utf8"),
      ),
    );
    expect(saved.words).toEqual(snapshot.assets[asset.id]?.artifact?.words);
  });

  it("leaves an interrupted running job queued on disk and exposes it as running in memory", async () => {
    const directory = await fixtureDirectory();
    const account = {
      requireCachedUser: () => ({ id: "user-1" }),
      authenticatedFetch: async () => new Response(),
    };
    const store = new TranscriptStore(account, async () => fingerprint);
    await store.setProject(directory, fixtureProject(), scope);
    await store.requestJobs(scope, [asset.id]);
    await store.beginJob(scope, asset.id);
    expect((await store.snapshot(scope)).assets[asset.id]?.state).toBe("running");

    const restored = new TranscriptStore(account, async () => fingerprint);
    await restored.setProject(directory, fixtureProject(), scope);
    expect((await restored.snapshot(scope)).assets[asset.id]?.state).toBe("queued");
  });

  it("records bounded failure codes without persisting provider detail", async () => {
    const directory = await fixtureDirectory();
    const account = {
      requireCachedUser: () => ({ id: "user-1" }),
      authenticatedFetch: async () => new Response(),
    };
    const store = new TranscriptStore(account, async () => fingerprint);
    await store.setProject(directory, fixtureProject(), scope);
    await store.requestJobs(scope, [asset.id]);
    const { jobId } = await store.beginJob(scope, asset.id);
    const snapshot = await store.failJob(
      scope,
      jobId,
      "provider-timeout",
      "A response containing private transcript text",
    );
    expect(snapshot.assets[asset.id]).toMatchObject({
      state: "failed",
      failureCode: "provider-timeout",
    });
    const index = await readFile(join(directory, ".video", "transcripts", "index.json"), "utf8");
    expect(index).not.toContain("private transcript text");
  });

  it("cancels queued and running work without leaving an active job", async () => {
    const directory = await fixtureDirectory();
    const account = {
      requireCachedUser: () => ({ id: "user-1" }),
      authenticatedFetch: async () => new Response(),
    };
    const store = new TranscriptStore(account, async () => fingerprint);
    await store.setProject(directory, fixtureProject(), scope);
    await store.requestJobs(scope, [asset.id]);
    const { jobId } = await store.beginJob(scope, asset.id);

    const canceled = await store.cancelJobs(scope, [asset.id]);
    expect(canceled.assets[asset.id]).toMatchObject({
      state: "failed",
      failureCode: "canceled",
    });
    await expect(store.finalizeJob(scope, jobId)).rejects.toThrow(/Unknown transcript job/);

    const retried = await store.requestJobs(scope, [asset.id]);
    expect(retried.assets[asset.id]?.state).toBe("queued");
  });

  it("requires a signed-in account before queueing remote work", async () => {
    const directory = await fixtureDirectory();
    const store = new TranscriptStore(null, async () => fingerprint);
    await store.setProject(directory, fixtureProject(), scope);
    await expect(store.requestJobs(scope, [asset.id])).rejects.toThrow(/unavailable/);
  });

  it("reserves a chunk index before awaiting the gateway", async () => {
    const directory = await fixtureDirectory();
    const response = deferred<Response>();
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(async () => response.promise),
    );
    const first = store.transcribeChunk(scope, completeChunk(jobId));

    await expect(store.transcribeChunk(scope, completeChunk(jobId))).rejects.toThrow(
      /Invalid transcript audio chunk/,
    );
    response.resolve(Response.json(oneChunkResponse()));
    await first;
    expect((await store.finalizeJob(scope, jobId)).assets[asset.id]?.state).toBe("ready");
  });

  it("rejects finalization while a chunk is in flight", async () => {
    const directory = await fixtureDirectory();
    const response = deferred<Response>();
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(async () => response.promise),
    );
    const chunk = store.transcribeChunk(scope, completeChunk(jobId));

    await expect(store.finalizeJob(scope, jobId)).rejects.toThrow(/busy/);
    response.resolve(Response.json(oneChunkResponse()));
    await chunk;
  });

  it("makes an in-flight gateway result inert after cancellation", async () => {
    const directory = await fixtureDirectory();
    const response = deferred<Response>();
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(async () => response.promise),
    );
    const chunk = store.transcribeChunk(scope, completeChunk(jobId));

    const canceled = await store.cancelJobs(scope, [asset.id]);
    response.resolve(Response.json(oneChunkResponse()));
    await expect(chunk).rejects.toThrow(/no longer active/);
    expect(canceled.assets[asset.id]).toMatchObject({ state: "failed", failureCode: "canceled" });
  });

  it("makes an in-flight result inert after switching projects", async () => {
    const firstDirectory = await fixtureDirectory();
    const secondDirectory = await fixtureDirectory();
    const response = deferred<Response>();
    const { store, jobId } = await preparedStore(
      firstDirectory,
      accountWith(async () => response.promise),
    );
    const chunk = store.transcribeChunk(scope, completeChunk(jobId));
    const nextScope = { ...scope, epoch: "123e4567-e89b-12d3-a456-426614174001" };

    await store.setProject(secondDirectory, fixtureProject(), nextScope);
    response.resolve(Response.json(oneChunkResponse()));
    await expect(chunk).rejects.toThrow(/no longer active/);
    expect((await store.snapshot(nextScope)).assets[asset.id]?.state).toBe("missing");
  });

  it("rolls back a reserved chunk when incremental persistence fails", async () => {
    const directory = await fixtureDirectory();
    const repository = new TranscriptChunkRepository();
    let failWrite = true;
    const chunkRepository: TranscriptChunkRepository = Object.create(repository);
    chunkRepository.write = async (...input) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("fixture write failure");
      }
      return repository.write(...input);
    };
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(async () => Response.json(oneChunkResponse())),
      { chunkRepository },
    );

    await expect(store.transcribeChunk(scope, completeChunk(jobId))).rejects.toThrow(
      /fixture write failure/,
    );
    await store.transcribeChunk(scope, completeChunk(jobId));
    expect((await store.finalizeJob(scope, jobId)).assets[asset.id]?.state).toBe("ready");
  });

  it("rejects an oversized gateway response before parsing JSON", async () => {
    const directory = await fixtureDirectory();
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(MAX_GATEWAY_RESPONSE_BYTES + 1) },
          }),
      ),
    );

    await expect(store.transcribeChunk(scope, completeChunk(jobId))).rejects.toThrow(/size limit/);
  });

  it("rejects non-contiguous source ranges", async () => {
    const directory = await fixtureDirectory();
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(async () => Response.json(oneChunkResponse())),
    );

    await expect(
      store.transcribeChunk(scope, {
        ...completeChunk(jobId),
        sourceStartUs: timeUs(1),
      }),
    ).rejects.toThrow(/Invalid transcript audio chunk/);
  });

  it("permits a deliberate retry after a gateway timeout", async () => {
    const directory = await fixtureDirectory();
    let calls = 0;
    const { store, jobId } = await preparedStore(
      directory,
      accountWith(async () => {
        calls += 1;
        if (calls === 1) throw new Error("gateway timeout");
        return Response.json(oneChunkResponse());
      }),
    );

    await expect(store.transcribeChunk(scope, completeChunk(jobId))).rejects.toThrow(/timeout/);
    await store.transcribeChunk(scope, completeChunk(jobId));
    expect((await store.finalizeJob(scope, jobId)).assets[asset.id]?.state).toBe("ready");
  });

  it("rejects artifacts that could map words outside the asset", () => {
    expect(() =>
      parseTranscriptArtifact({
        version: 1,
        assetId: asset.id,
        sourceFingerprint: fingerprint,
        generator: {
          gateway: "direct",
          provider: "deepgram",
          model: "deepgram/nova-3",
          version: "deepgram-nova-3@3",
        },
        options: {
          language: null,
          detectLanguage: true,
          multilingual: true,
          diarization: true,
          utterances: true,
          paragraphs: true,
          smartFormat: true,
          punctuation: true,
          fillerWords: true,
          profanityFilter: false,
          redactPersonalInformation: false,
          keyterms: [],
        },
        language: "en",
        durationUs: timeUs(10),
        words: [
          { id: "word_000001", text: "invalid", sourceStartUs: timeUs(5), sourceEndUs: timeUs(20) },
        ],
        utterances: [],
      }),
    ).toThrow(/word exceeds asset duration/);
  });
});
