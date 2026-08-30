import { createHash, randomUUID } from "node:crypto";
import type {
  EditingTranscriptionGateway,
  GatewayTranscript,
  TranscriptionGatewayInput,
} from "./service";

export interface TranscriptionResourceLimits {
  perUserConcurrency: number;
  serviceConcurrency: number;
  requestsPerMinute: number;
  networkRequestsPerMinute: number;
  userMonthlySeconds: number;
  serviceMonthlySeconds: number;
  maximumRequestSeconds: number;
  providerTimeoutMs: number;
}

export interface TranscriptionReservationInput {
  id: string;
  userId: string;
  networkKey: string;
  estimatedSeconds: number;
  now: Date;
}

export interface TranscriptionUsageSnapshot {
  activeForUser: number;
  activeForService: number;
  recentForUser: number;
  recentForNetwork: number;
  userChargedSeconds: number;
  serviceChargedSeconds: number;
}

export interface TranscriptionReservationStore {
  reserve(input: TranscriptionReservationInput, limits: TranscriptionResourceLimits): Promise<void>;
  settle(id: string, actualSeconds?: number): Promise<void>;
}

export class TranscriptionResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 429 = 429,
  ) {
    super(message);
    this.name = "TranscriptionResourceError";
  }
}

export function assertReservationAllowed(
  snapshot: TranscriptionUsageSnapshot,
  estimatedSeconds: number,
  limits: TranscriptionResourceLimits,
): void {
  if (!Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0) {
    throw new TranscriptionResourceError(
      "invalid_audio_duration",
      "A positive audio duration is required",
      400,
    );
  }
  if (estimatedSeconds > limits.maximumRequestSeconds) {
    throw new TranscriptionResourceError(
      "audio_duration_too_large",
      `Audio chunks may not exceed ${limits.maximumRequestSeconds} seconds`,
      400,
    );
  }
  if (snapshot.activeForUser >= limits.perUserConcurrency) {
    throw new TranscriptionResourceError(
      "user_concurrency_exceeded",
      "Too many transcription requests are already active for this account",
    );
  }
  if (snapshot.activeForService >= limits.serviceConcurrency) {
    throw new TranscriptionResourceError(
      "service_concurrency_exceeded",
      "The transcription service is at capacity",
    );
  }
  if (snapshot.recentForUser >= limits.requestsPerMinute) {
    throw new TranscriptionResourceError(
      "user_rate_exceeded",
      "The transcription request rate for this account was exceeded",
    );
  }
  if (snapshot.recentForNetwork >= limits.networkRequestsPerMinute) {
    throw new TranscriptionResourceError(
      "network_rate_exceeded",
      "The transcription request rate for this network was exceeded",
    );
  }
  if (snapshot.userChargedSeconds + estimatedSeconds > limits.userMonthlySeconds) {
    throw new TranscriptionResourceError(
      "user_transcription_quota_exceeded",
      "The account transcription allowance has been exhausted",
    );
  }
  if (snapshot.serviceChargedSeconds + estimatedSeconds > limits.serviceMonthlySeconds) {
    throw new TranscriptionResourceError(
      "service_transcription_budget_exceeded",
      "The transcription service budget has been exhausted",
    );
  }
}

export function transcriptionNetworkKey(address: string, salt: string): string {
  return createHash("sha256").update(salt).update("\0").update(address).digest("hex");
}

interface MemoryReservation extends TranscriptionReservationInput {
  period: string;
  chargedSeconds: number;
  active: boolean;
}

function periodFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export class InMemoryTranscriptionReservationStore implements TranscriptionReservationStore {
  readonly #reservations = new Map<string, MemoryReservation>();

  async reserve(
    input: TranscriptionReservationInput,
    limits: TranscriptionResourceLimits,
  ): Promise<void> {
    const period = periodFor(input.now);
    const recentAt = input.now.getTime() - 60_000;
    const reservations = [...this.#reservations.values()];
    const currentPeriod = reservations.filter((reservation) => reservation.period === period);
    const active = reservations.filter(
      (reservation) =>
        reservation.active &&
        reservation.now.getTime() + limits.providerTimeoutMs + 30_000 > input.now.getTime(),
    );
    assertReservationAllowed(
      {
        activeForUser: active.filter((reservation) => reservation.userId === input.userId).length,
        activeForService: active.length,
        recentForUser: reservations.filter(
          (reservation) =>
            reservation.userId === input.userId && reservation.now.getTime() >= recentAt,
        ).length,
        recentForNetwork: reservations.filter(
          (reservation) =>
            reservation.networkKey === input.networkKey && reservation.now.getTime() >= recentAt,
        ).length,
        userChargedSeconds: currentPeriod
          .filter((reservation) => reservation.userId === input.userId)
          .reduce((total, reservation) => total + reservation.chargedSeconds, 0),
        serviceChargedSeconds: currentPeriod.reduce(
          (total, reservation) => total + reservation.chargedSeconds,
          0,
        ),
      },
      input.estimatedSeconds,
      limits,
    );
    this.#reservations.set(input.id, {
      ...input,
      period,
      chargedSeconds: input.estimatedSeconds,
      active: true,
    });
  }

  async settle(id: string, actualSeconds?: number): Promise<void> {
    const reservation = this.#reservations.get(id);
    if (!reservation || !reservation.active) return;
    reservation.active = false;
    if (actualSeconds !== undefined && Number.isFinite(actualSeconds) && actualSeconds > 0) {
      reservation.chargedSeconds = actualSeconds;
    }
  }

  snapshot(userId: string, at = new Date()): { active: number; chargedSeconds: number } {
    const period = periodFor(at);
    const reservations = [...this.#reservations.values()].filter(
      (reservation) => reservation.userId === userId,
    );
    return {
      active: reservations.filter((reservation) => reservation.active).length,
      chargedSeconds: reservations
        .filter((reservation) => reservation.period === period)
        .reduce((total, reservation) => total + reservation.chargedSeconds, 0),
    };
  }
}

export class TranscriptionResourcePolicy {
  constructor(
    private readonly store: TranscriptionReservationStore,
    readonly limits: TranscriptionResourceLimits,
  ) {}

  async transcribe(
    identity: { userId: string; networkKey: string; estimatedSeconds: number },
    gateway: EditingTranscriptionGateway,
    input: TranscriptionGatewayInput,
  ): Promise<GatewayTranscript> {
    const id = randomUUID();
    await this.store.reserve({ ...identity, id, now: new Date() }, this.limits);
    const timeout = AbortSignal.timeout(this.limits.providerTimeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const transcript = await gateway.transcribe({ ...input, signal });
      await this.store.settle(id, transcript.durationSeconds ?? identity.estimatedSeconds);
      return transcript;
    } catch (error) {
      await this.store.settle(id);
      throw error;
    }
  }
}
