import { and, count, eq, gt, gte, lt, ne, sql, sum } from "drizzle-orm";
import { db } from "../db/client";
import { transcriptionRequest, transcriptionUsage } from "../db/schema";
import {
  assertReservationAllowed,
  type TranscriptionReservationInput,
  type TranscriptionReservationStore,
  type TranscriptionResourceLimits,
} from "./resource-policy";

const POLICY_LOCK = "cinesim:transcription-resource-policy:v1";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function periodFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function milliseconds(seconds: number): number {
  return Math.ceil(seconds * 1_000);
}

export class PostgresTranscriptionReservationStore implements TranscriptionReservationStore {
  async reserve(
    input: TranscriptionReservationInput,
    limits: TranscriptionResourceLimits,
  ): Promise<void> {
    const period = periodFor(input.now);
    const recent = new Date(input.now.getTime() - 60_000);
    const expiresAt = new Date(input.now.getTime() + limits.providerTimeoutMs + 30_000);
    const reservedMilliseconds = milliseconds(input.estimatedSeconds);

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${POLICY_LOCK}))`);
      await transaction
        .delete(transcriptionRequest)
        .where(lt(transcriptionRequest.createdAt, new Date(input.now.getTime() - RETENTION_MS)));
      await transaction
        .insert(transcriptionUsage)
        .values({ userId: input.userId, period })
        .onConflictDoNothing();
      const [userUsage] = await transaction
        .select()
        .from(transcriptionUsage)
        .where(
          and(eq(transcriptionUsage.userId, input.userId), eq(transcriptionUsage.period, period)),
        )
        .for("update")
        .limit(1);
      if (!userUsage) throw new Error("Transcription usage could not be initialized");
      const activeCondition = and(
        eq(transcriptionRequest.state, "active"),
        gt(transcriptionRequest.expiresAt, input.now),
      );
      const [[activeForUser], [activeForService], [recentForUser], [recentForNetwork], [service]] =
        await Promise.all([
          transaction
            .select({ value: count() })
            .from(transcriptionRequest)
            .where(and(activeCondition, eq(transcriptionRequest.userId, input.userId))),
          transaction.select({ value: count() }).from(transcriptionRequest).where(activeCondition),
          transaction
            .select({ value: count() })
            .from(transcriptionRequest)
            .where(
              and(
                eq(transcriptionRequest.userId, input.userId),
                gte(transcriptionRequest.createdAt, recent),
              ),
            ),
          transaction
            .select({ value: count() })
            .from(transcriptionRequest)
            .where(
              and(
                eq(transcriptionRequest.networkKey, input.networkKey),
                gte(transcriptionRequest.createdAt, recent),
              ),
            ),
          transaction
            .select({ value: sum(transcriptionUsage.chargedMilliseconds) })
            .from(transcriptionUsage)
            .where(eq(transcriptionUsage.period, period)),
        ]);
      assertReservationAllowed(
        {
          activeForUser: activeForUser?.value ?? 0,
          activeForService: activeForService?.value ?? 0,
          recentForUser: recentForUser?.value ?? 0,
          recentForNetwork: recentForNetwork?.value ?? 0,
          userChargedSeconds: userUsage.chargedMilliseconds / 1_000,
          serviceChargedSeconds: Number(service?.value ?? 0) / 1_000,
        },
        input.estimatedSeconds,
        limits,
      );
      await transaction
        .update(transcriptionUsage)
        .set({
          chargedMilliseconds: userUsage.chargedMilliseconds + reservedMilliseconds,
          requestCount: userUsage.requestCount + 1,
        })
        .where(
          and(eq(transcriptionUsage.userId, input.userId), eq(transcriptionUsage.period, period)),
        );
      await transaction.insert(transcriptionRequest).values({
        id: input.id,
        userId: input.userId,
        networkKey: input.networkKey,
        period,
        state: "active",
        reservedMilliseconds,
        chargedMilliseconds: reservedMilliseconds,
        createdAt: input.now,
        expiresAt,
      });
    });
  }

  async settle(id: string, actualSeconds?: number): Promise<void> {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${POLICY_LOCK}))`);
      const [request] = await transaction
        .select()
        .from(transcriptionRequest)
        .where(eq(transcriptionRequest.id, id))
        .for("update")
        .limit(1);
      if (!request || request.state !== "active") return;
      const chargedMilliseconds =
        actualSeconds === undefined || !Number.isFinite(actualSeconds) || actualSeconds <= 0
          ? request.reservedMilliseconds
          : milliseconds(actualSeconds);
      const difference = chargedMilliseconds - request.chargedMilliseconds;
      if (difference !== 0) {
        await transaction
          .update(transcriptionUsage)
          .set({
            chargedMilliseconds: sql`${transcriptionUsage.chargedMilliseconds} + ${difference}`,
          })
          .where(
            and(
              eq(transcriptionUsage.userId, request.userId),
              eq(transcriptionUsage.period, request.period),
            ),
          );
      }
      await transaction
        .update(transcriptionRequest)
        .set({
          state: actualSeconds === undefined ? "failed" : "completed",
          chargedMilliseconds,
          completedAt: new Date(),
        })
        .where(and(eq(transcriptionRequest.id, id), ne(transcriptionRequest.state, "completed")));
    });
  }
}
