import { describe, expect, it } from "vite-plus/test";
import type {
  EditingTranscriptionGateway,
  GatewayTranscript,
  TranscriptionGatewayInput,
} from "../src/transcriptions/service";
import {
  InMemoryTranscriptionReservationStore,
  TranscriptionResourcePolicy,
  type TranscriptionResourceLimits,
} from "../src/transcriptions/resource-policy";

const limits: TranscriptionResourceLimits = {
  perUserConcurrency: 2,
  serviceConcurrency: 3,
  requestsPerMinute: 3,
  networkRequestsPerMinute: 4,
  userMonthlySeconds: 100,
  serviceMonthlySeconds: 250,
  maximumRequestSeconds: 60,
  providerTimeoutMs: 25,
};

const transcript = (durationSeconds: number): GatewayTranscript => ({
  requestId: "request-1",
  model: "deepgram/nova-3",
  text: "",
  language: null,
  durationSeconds,
  words: [],
  utterances: [],
});

const input = (signal?: AbortSignal): TranscriptionGatewayInput => ({
  audio: new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  }),
  format: "wav",
  contentType: "audio/wav",
  language: null,
  keyterms: [],
  ...(signal ? { signal } : {}),
});

const identity = (userId: string, networkKey = "network-1", estimatedSeconds = 10) => ({
  userId,
  networkKey,
  estimatedSeconds,
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!complete) throw new Error("Deferred promise was not initialized");
      complete(value);
    },
  };
}

describe("transcription resource policy", () => {
  it("atomically bounds per-user and service concurrency", async () => {
    const store = new InMemoryTranscriptionReservationStore();
    const policy = new TranscriptionResourcePolicy(store, limits);
    const pending = deferred<GatewayTranscript>();
    const gateway: EditingTranscriptionGateway = { transcribe: () => pending.promise };
    const first = policy.transcribe(identity("user-1"), gateway, input());
    const second = policy.transcribe(identity("user-1"), gateway, input());

    await expect(policy.transcribe(identity("user-1"), gateway, input())).rejects.toMatchObject({
      code: "user_concurrency_exceeded",
    });
    const thirdUser = policy.transcribe(identity("user-2"), gateway, input());
    await expect(policy.transcribe(identity("user-3"), gateway, input())).rejects.toMatchObject({
      code: "service_concurrency_exceeded",
    });

    pending.resolve(transcript(8));
    await Promise.all([first, second, thirdUser]);
    expect(store.snapshot("user-1")).toEqual({ active: 0, chargedSeconds: 16 });
  });

  it("charges retries and enforces user, network, and monthly budgets", async () => {
    const immediate: EditingTranscriptionGateway = {
      transcribe: () => Promise.resolve(transcript(10)),
    };
    const userRateStore = new InMemoryTranscriptionReservationStore();
    const userRatePolicy = new TranscriptionResourcePolicy(userRateStore, limits);
    await userRatePolicy.transcribe(identity("user-1"), immediate, input());
    await userRatePolicy.transcribe(identity("user-1"), immediate, input());
    await userRatePolicy.transcribe(identity("user-1"), immediate, input());
    await expect(
      userRatePolicy.transcribe(identity("user-1"), immediate, input()),
    ).rejects.toMatchObject({ code: "user_rate_exceeded" });

    const networkStore = new InMemoryTranscriptionReservationStore();
    const networkPolicy = new TranscriptionResourcePolicy(networkStore, limits);
    for (let index = 0; index < limits.networkRequestsPerMinute; index += 1) {
      await networkPolicy.transcribe(
        identity(`user-${index}`, "shared-network"),
        immediate,
        input(),
      );
    }
    await expect(
      networkPolicy.transcribe(identity("user-last", "shared-network"), immediate, input()),
    ).rejects.toMatchObject({ code: "network_rate_exceeded" });

    const quotaStore = new InMemoryTranscriptionReservationStore();
    const quotaPolicy = new TranscriptionResourcePolicy(quotaStore, limits);
    const longGateway: EditingTranscriptionGateway = {
      transcribe: () => Promise.resolve(transcript(60)),
    };
    await quotaPolicy.transcribe(identity("user-1", "network-1", 60), longGateway, input());
    await expect(
      quotaPolicy.transcribe(identity("user-1", "network-2", 50), immediate, input()),
    ).rejects.toMatchObject({ code: "user_transcription_quota_exceeded" });

    const serviceStore = new InMemoryTranscriptionReservationStore();
    const servicePolicy = new TranscriptionResourcePolicy(serviceStore, limits);
    for (let index = 0; index < 4; index += 1) {
      await servicePolicy.transcribe(
        identity(`budget-user-${index}`, `budget-network-${index}`, 60),
        longGateway,
        input(),
      );
    }
    await expect(
      servicePolicy.transcribe(
        identity("budget-user-last", "budget-network-last", 20),
        immediate,
        input(),
      ),
    ).rejects.toMatchObject({ code: "service_transcription_budget_exceeded" });
  });

  it("cancels timed-out providers and releases active capacity without refunding spend", async () => {
    const store = new InMemoryTranscriptionReservationStore();
    const policy = new TranscriptionResourcePolicy(store, limits);
    const gateway: EditingTranscriptionGateway = {
      transcribe(providerInput) {
        return new Promise((_resolve, reject) => {
          if (providerInput.signal?.aborted) {
            reject(providerInput.signal.reason);
            return;
          }
          providerInput.signal?.addEventListener(
            "abort",
            () => reject(providerInput.signal?.reason),
            { once: true },
          );
        });
      },
    };

    await expect(policy.transcribe(identity("user-1"), gateway, input())).rejects.toBeDefined();
    expect(store.snapshot("user-1")).toEqual({ active: 0, chargedSeconds: 10 });
  });

  it("propagates disconnect cancellation through the provider boundary", async () => {
    const store = new InMemoryTranscriptionReservationStore();
    const policy = new TranscriptionResourcePolicy(store, { ...limits, providerTimeoutMs: 1_000 });
    const controller = new AbortController();
    const gateway: EditingTranscriptionGateway = {
      transcribe(providerInput) {
        return new Promise((_resolve, reject) => {
          if (providerInput.signal?.aborted) {
            reject(providerInput.signal.reason);
            return;
          }
          providerInput.signal?.addEventListener(
            "abort",
            () => reject(providerInput.signal?.reason),
            { once: true },
          );
        });
      },
    };
    const request = policy.transcribe(identity("user-1"), gateway, input(controller.signal));

    controller.abort(new Error("client disconnected"));

    await expect(request).rejects.toThrow("client disconnected");
    expect(store.snapshot("user-1").active).toBe(0);
  });
});
