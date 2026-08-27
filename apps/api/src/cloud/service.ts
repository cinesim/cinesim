import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/client";
import {
  cloudAsset,
  cloudProject,
  cloudUpload,
  cloudUploadPart,
  storageEntitlement,
} from "../db/schema";
import type { R2ObjectStore } from "./r2";

const MULTIPART_PART_SIZE = 64 * 1024 * 1024;
const MULTIPART_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class CloudStorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 = 400,
  ) {
    super(message);
    this.name = "CloudStorageError";
  }
}

interface SourceFingerprintInput {
  size: number;
  mtimeMs: number;
  edgeHash: string;
}

interface UploadContext {
  upload: typeof cloudUpload.$inferSelect;
  asset: typeof cloudAsset.$inferSelect;
  project: typeof cloudProject.$inferSelect;
}

function cloudId(prefix: "asset" | "upload"): string {
  return `cloud_${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function storageNamespace(): string {
  return `storage_${randomUUID().replaceAll("-", "")}`;
}

export class CloudStorageService {
  constructor(
    private readonly objectStore: R2ObjectStore,
    private readonly includedBytes: number,
    private readonly addonOptionsBytes: number[],
  ) {}

  async usage(userId: string) {
    await this.#maintainAccount(userId);
    await this.#ensureEntitlement(userId);
    const [entitlement] = await db
      .select()
      .from(storageEntitlement)
      .where(eq(storageEntitlement.userId, userId))
      .limit(1);
    const projects = await db.select().from(cloudProject).where(eq(cloudProject.userId, userId));
    const projectIds = projects.map((project) => project.id);
    const assets =
      projectIds.length === 0
        ? []
        : await db.select().from(cloudAsset).where(inArray(cloudAsset.projectId, projectIds));
    return {
      includedBytes: entitlement!.includedBytes,
      addonBytes: entitlement!.addonBytes,
      usedBytes: entitlement!.usedBytes,
      reservedBytes: entitlement!.reservedBytes,
      addonOptionsBytes: this.addonOptionsBytes,
      projects: projects
        .map((project) => {
          const projectAssets = assets
            .filter((asset) => asset.projectId === project.id && asset.state !== "deleted")
            .map((asset) => ({
              id: asset.id,
              clientAssetId: asset.clientAssetId,
              name: asset.originalName,
              kind: asset.mediaKind,
              bytes: asset.bytes,
              state: asset.state,
              trashedAt: asset.trashedAt?.toISOString() ?? null,
            }));
          return {
            id: project.id,
            clientProjectId: project.clientProjectId,
            name: project.name,
            usedBytes: projectAssets
              .filter((asset) => asset.state === "ready" || asset.state === "trashed")
              .reduce((total, asset) => total + asset.bytes, 0),
            reservedBytes: projectAssets
              .filter((asset) => asset.state === "uploading")
              .reduce((total, asset) => total + asset.bytes, 0),
            assets: projectAssets,
          };
        })
        .sort(
          (left, right) => right.usedBytes - left.usedBytes || left.name.localeCompare(right.name),
        ),
    };
  }

  async setAddonBytes(userId: string, addonBytes: number): Promise<void> {
    if (!this.addonOptionsBytes.includes(addonBytes))
      throw new CloudStorageError(
        "STORAGE_ALLOWANCE_UNAVAILABLE",
        "That storage allowance is not available",
      );
    await this.#ensureEntitlement(userId);
    const [entitlement] = await db
      .select()
      .from(storageEntitlement)
      .where(eq(storageEntitlement.userId, userId))
      .limit(1);
    if (!entitlement) throw new Error("Storage entitlement is unavailable");
    if (entitlement.usedBytes + entitlement.reservedBytes > entitlement.includedBytes + addonBytes)
      throw new CloudStorageError(
        "STORAGE_ALLOWANCE_IN_USE",
        "Remove cloud originals before reducing storage below current usage",
        409,
      );
    await db
      .update(storageEntitlement)
      .set({ addonBytes })
      .where(eq(storageEntitlement.userId, userId));
  }

  async createUpload(
    userId: string,
    input: {
      cloudProjectId: string;
      clientAssetId: string;
      name: string;
      kind: "video" | "audio" | "image";
      contentType: string;
      bytes: number;
      checksumSha256: string;
      sourceFingerprint: SourceFingerprintInput;
    },
  ) {
    const [project] = await db
      .select()
      .from(cloudProject)
      .where(and(eq(cloudProject.id, input.cloudProjectId), eq(cloudProject.userId, userId)))
      .limit(1);
    if (!project)
      throw new CloudStorageError(
        "CLOUD_PROJECT_NOT_FOUND",
        "The cloud project is unavailable for this account",
        404,
      );

    const [existing] = await db
      .select()
      .from(cloudAsset)
      .where(
        and(
          eq(cloudAsset.projectId, project.id),
          eq(cloudAsset.clientAssetId, input.clientAssetId),
        ),
      )
      .limit(1);
    if (existing?.state === "ready" || existing?.state === "trashed")
      throw new CloudStorageError(
        "CLOUD_ASSET_EXISTS",
        "This project asset already has a cloud original",
        409,
      );
    if (existing?.state === "uploading") return this.#uploadSnapshot(userId, existing.id);
    if (existing) await db.delete(cloudAsset).where(eq(cloudAsset.id, existing.id));

    const assetId = cloudId("asset");
    const uploadId = cloudId("upload");
    const namespace = await db.transaction(async (transaction) => {
      await transaction
        .insert(storageEntitlement)
        .values({
          userId,
          storageNamespace: storageNamespace(),
          includedBytes: this.includedBytes,
        })
        .onConflictDoNothing();
      const [entitlement] = await transaction
        .select()
        .from(storageEntitlement)
        .where(eq(storageEntitlement.userId, userId))
        .for("update")
        .limit(1);
      if (!entitlement) throw new Error("Storage entitlement could not be created");
      const limit = entitlement.includedBytes + entitlement.addonBytes;
      if (entitlement.usedBytes + entitlement.reservedBytes + input.bytes > limit)
        throw new CloudStorageError(
          "STORAGE_QUOTA_EXCEEDED",
          "This upload exceeds the account storage allowance",
          413,
        );
      await transaction
        .update(storageEntitlement)
        .set({ reservedBytes: entitlement.reservedBytes + input.bytes })
        .where(eq(storageEntitlement.userId, userId));
      const objectKey = `accounts/${entitlement.storageNamespace}/projects/${project.id}/assets/${assetId}/original`;
      await transaction.insert(cloudAsset).values({
        id: assetId,
        projectId: project.id,
        userId,
        clientAssetId: input.clientAssetId,
        objectKey,
        originalName: input.name,
        mediaKind: input.kind,
        contentType: input.contentType,
        bytes: input.bytes,
        reservedBytes: input.bytes,
        checksumSha256: input.checksumSha256,
        state: "preparing",
      });
      return { namespace: entitlement.storageNamespace, objectKey };
    });

    try {
      const r2UploadId = await this.objectStore.createMultipartUpload({
        key: namespace.objectKey,
        contentType: input.contentType,
        checksumSha256: input.checksumSha256,
      });
      const expiresAt = new Date(Date.now() + MULTIPART_EXPIRY_MS);
      await db.transaction(async (transaction) => {
        await transaction.insert(cloudUpload).values({
          id: uploadId,
          assetId,
          r2UploadId,
          partSize: MULTIPART_PART_SIZE,
          sourceSize: input.sourceFingerprint.size,
          sourceMtimeMs: Math.round(input.sourceFingerprint.mtimeMs),
          sourceEdgeHash: input.sourceFingerprint.edgeHash,
          state: "uploading",
          expiresAt,
        });
        await transaction
          .update(cloudAsset)
          .set({ state: "uploading" })
          .where(eq(cloudAsset.id, assetId));
      });
      return {
        id: uploadId,
        cloudAssetId: assetId,
        partSize: MULTIPART_PART_SIZE,
        bytes: input.bytes,
        expiresAt: expiresAt.toISOString(),
        parts: [],
      };
    } catch (error) {
      await this.#releaseReservation(userId, assetId, input.bytes);
      throw error;
    }
  }

  async upload(userId: string, uploadId: string) {
    const context = await this.#requireUpload(userId, uploadId);
    return this.#uploadSnapshot(userId, context.asset.id);
  }

  async signParts(userId: string, uploadId: string, partNumbers: number[]) {
    const context = await this.#requireUpload(userId, uploadId);
    if (context.upload.state !== "uploading")
      throw new CloudStorageError("UPLOAD_NOT_ACTIVE", "The upload is not active", 409);
    const maximumPart = Math.ceil(context.asset.bytes / context.upload.partSize);
    if (
      partNumbers.length === 0 ||
      partNumbers.length > 16 ||
      partNumbers.some(
        (partNumber) =>
          !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > maximumPart,
      )
    )
      throw new CloudStorageError("INVALID_PARTS", "Invalid multipart upload part request");
    const unique = [...new Set(partNumbers)].toSorted((left, right) => left - right);
    return Promise.all(
      unique.map(async (partNumber) => ({
        partNumber,
        url: await this.objectStore.signUploadPart({
          key: context.asset.objectKey,
          uploadId: context.upload.r2UploadId,
          partNumber,
        }),
      })),
    );
  }

  async recordPart(
    userId: string,
    uploadId: string,
    input: { partNumber: number; etag: string; bytes: number },
  ) {
    const context = await this.#requireUpload(userId, uploadId);
    if (context.upload.state !== "uploading")
      throw new CloudStorageError("UPLOAD_NOT_ACTIVE", "The upload is not active", 409);
    const maximumPart = Math.ceil(context.asset.bytes / context.upload.partSize);
    const expectedBytes =
      input.partNumber === maximumPart
        ? context.asset.bytes - context.upload.partSize * (maximumPart - 1)
        : context.upload.partSize;
    if (
      !Number.isSafeInteger(input.partNumber) ||
      input.partNumber < 1 ||
      input.partNumber > maximumPart ||
      input.bytes !== expectedBytes ||
      !/^"?[a-fA-F0-9]{32}(?:-\d+)?"?$/.test(input.etag)
    )
      throw new CloudStorageError("INVALID_PART", "Invalid completed multipart part");
    await db
      .insert(cloudUploadPart)
      .values({ uploadId, partNumber: input.partNumber, etag: input.etag, bytes: input.bytes })
      .onConflictDoUpdate({
        target: [cloudUploadPart.uploadId, cloudUploadPart.partNumber],
        set: { etag: input.etag, bytes: input.bytes },
      });
    return this.#uploadSnapshot(userId, context.asset.id);
  }

  async completeUpload(userId: string, uploadId: string) {
    const context = await this.#requireUpload(userId, uploadId);
    if (context.asset.state === "ready")
      return { cloudAssetId: context.asset.id, bytes: context.asset.bytes };
    if (context.upload.state !== "uploading")
      throw new CloudStorageError("UPLOAD_NOT_ACTIVE", "The upload is not active", 409);
    const parts = (
      await db.select().from(cloudUploadPart).where(eq(cloudUploadPart.uploadId, uploadId))
    ).toSorted((left, right) => left.partNumber - right.partNumber);
    const expectedPartCount = Math.ceil(context.asset.bytes / context.upload.partSize);
    if (
      parts.length !== expectedPartCount ||
      parts.some((part, index) => part.partNumber !== index + 1)
    )
      throw new CloudStorageError(
        "UPLOAD_INCOMPLETE",
        "All upload parts must finish before completion",
        409,
      );
    const etag = await this.objectStore.completeMultipartUpload({
      key: context.asset.objectKey,
      uploadId: context.upload.r2UploadId,
      parts,
    });
    const verified = await this.objectStore.headObject(context.asset.objectKey);
    if (verified.bytes !== context.asset.bytes)
      throw new CloudStorageError(
        "UPLOAD_SIZE_MISMATCH",
        "The stored original does not match the source size",
        409,
      );
    await db.transaction(async (transaction) => {
      const [entitlement] = await transaction
        .select()
        .from(storageEntitlement)
        .where(eq(storageEntitlement.userId, userId))
        .for("update")
        .limit(1);
      if (!entitlement) throw new Error("Storage entitlement is unavailable");
      await transaction
        .update(storageEntitlement)
        .set({
          usedBytes: entitlement.usedBytes + context.asset.bytes,
          reservedBytes: Math.max(0, entitlement.reservedBytes - context.asset.reservedBytes),
        })
        .where(eq(storageEntitlement.userId, userId));
      await transaction
        .update(cloudAsset)
        .set({ state: "ready", reservedBytes: 0, r2Etag: verified.etag ?? etag })
        .where(eq(cloudAsset.id, context.asset.id));
      await transaction
        .update(cloudUpload)
        .set({ state: "complete" })
        .where(eq(cloudUpload.id, uploadId));
    });
    return { cloudAssetId: context.asset.id, bytes: context.asset.bytes };
  }

  async abortUpload(userId: string, uploadId: string): Promise<void> {
    const context = await this.#requireUpload(userId, uploadId);
    if (context.upload.state !== "uploading") return;
    await this.objectStore.abortMultipartUpload({
      key: context.asset.objectKey,
      uploadId: context.upload.r2UploadId,
    });
    await this.#releaseReservation(userId, context.asset.id, context.asset.reservedBytes);
  }

  async downloadUrl(userId: string, cloudAssetId: string): Promise<{ url: string; bytes: number }> {
    const asset = await this.#requireAsset(userId, cloudAssetId);
    if (asset.state !== "ready")
      throw new CloudStorageError(
        "CLOUD_ASSET_UNAVAILABLE",
        "The cloud original is unavailable",
        409,
      );
    return { url: await this.objectStore.signDownload(asset.objectKey), bytes: asset.bytes };
  }

  async trashAsset(userId: string, cloudAssetId: string): Promise<void> {
    const asset = await this.#requireAsset(userId, cloudAssetId);
    if (asset.state !== "ready")
      throw new CloudStorageError(
        "CLOUD_ASSET_UNAVAILABLE",
        "Only ready assets can be trashed",
        409,
      );
    await db
      .update(cloudAsset)
      .set({ state: "trashed", trashedAt: new Date() })
      .where(eq(cloudAsset.id, asset.id));
  }

  async restoreAsset(userId: string, cloudAssetId: string): Promise<void> {
    const asset = await this.#requireAsset(userId, cloudAssetId);
    if (asset.state !== "trashed")
      throw new CloudStorageError("CLOUD_ASSET_NOT_TRASHED", "The asset is not in Trash", 409);
    await db
      .update(cloudAsset)
      .set({ state: "ready", trashedAt: null })
      .where(eq(cloudAsset.id, asset.id));
  }

  async purgeAsset(userId: string, cloudAssetId: string): Promise<void> {
    const asset = await this.#requireAsset(userId, cloudAssetId);
    if (asset.state !== "trashed")
      throw new CloudStorageError(
        "CLOUD_ASSET_NOT_TRASHED",
        "Move the asset to Trash before deleting it permanently",
        409,
      );
    await this.objectStore.deleteObject(asset.objectKey);
    await db.transaction(async (transaction) => {
      const [entitlement] = await transaction
        .select()
        .from(storageEntitlement)
        .where(eq(storageEntitlement.userId, userId))
        .for("update")
        .limit(1);
      if (!entitlement) throw new Error("Storage entitlement is unavailable");
      await transaction
        .update(storageEntitlement)
        .set({ usedBytes: Math.max(0, entitlement.usedBytes - asset.bytes) })
        .where(eq(storageEntitlement.userId, userId));
      await transaction.delete(cloudAsset).where(eq(cloudAsset.id, asset.id));
    });
  }

  async #ensureEntitlement(userId: string): Promise<void> {
    await db
      .insert(storageEntitlement)
      .values({
        userId,
        storageNamespace: storageNamespace(),
        includedBytes: this.includedBytes,
      })
      .onConflictDoNothing();
  }

  async #maintainAccount(userId: string): Promise<void> {
    const expiredUploads = await db
      .select({ id: cloudUpload.id })
      .from(cloudUpload)
      .innerJoin(cloudAsset, eq(cloudUpload.assetId, cloudAsset.id))
      .where(
        and(
          eq(cloudAsset.userId, userId),
          eq(cloudUpload.state, "uploading"),
          lt(cloudUpload.expiresAt, new Date()),
        ),
      );
    for (const upload of expiredUploads)
      await this.abortUpload(userId, upload.id).catch(() => undefined);

    const expiredTrash = await db
      .select({ id: cloudAsset.id })
      .from(cloudAsset)
      .where(
        and(
          eq(cloudAsset.userId, userId),
          eq(cloudAsset.state, "trashed"),
          lt(cloudAsset.trashedAt, new Date(Date.now() - TRASH_RETENTION_MS)),
        ),
      );
    for (const asset of expiredTrash)
      await this.purgeAsset(userId, asset.id).catch(() => undefined);
  }

  async #requireAsset(userId: string, cloudAssetId: string) {
    const [asset] = await db
      .select()
      .from(cloudAsset)
      .where(and(eq(cloudAsset.id, cloudAssetId), eq(cloudAsset.userId, userId)))
      .limit(1);
    if (!asset)
      throw new CloudStorageError(
        "CLOUD_ASSET_NOT_FOUND",
        "The cloud asset is unavailable for this account",
        404,
      );
    return asset;
  }

  async #requireUpload(userId: string, uploadId: string): Promise<UploadContext> {
    const [context] = await db
      .select({ upload: cloudUpload, asset: cloudAsset, project: cloudProject })
      .from(cloudUpload)
      .innerJoin(cloudAsset, eq(cloudUpload.assetId, cloudAsset.id))
      .innerJoin(cloudProject, eq(cloudAsset.projectId, cloudProject.id))
      .where(and(eq(cloudUpload.id, uploadId), eq(cloudAsset.userId, userId)))
      .limit(1);
    if (!context)
      throw new CloudStorageError(
        "UPLOAD_NOT_FOUND",
        "The cloud upload is unavailable for this account",
        404,
      );
    return context;
  }

  async #uploadSnapshot(userId: string, assetId: string) {
    const [context] = await db
      .select({ upload: cloudUpload, asset: cloudAsset })
      .from(cloudUpload)
      .innerJoin(cloudAsset, eq(cloudUpload.assetId, cloudAsset.id))
      .where(and(eq(cloudAsset.id, assetId), eq(cloudAsset.userId, userId)))
      .limit(1);
    if (!context)
      throw new CloudStorageError("UPLOAD_NOT_FOUND", "The cloud upload is unavailable", 404);
    const parts = await db
      .select()
      .from(cloudUploadPart)
      .where(eq(cloudUploadPart.uploadId, context.upload.id));
    return {
      id: context.upload.id,
      cloudAssetId: context.asset.id,
      partSize: context.upload.partSize,
      bytes: context.asset.bytes,
      expiresAt: context.upload.expiresAt.toISOString(),
      state: context.upload.state,
      sourceFingerprint: {
        size: context.upload.sourceSize,
        mtimeMs: context.upload.sourceMtimeMs,
        edgeHash: context.upload.sourceEdgeHash,
      },
      parts: parts
        .map((part) => ({ partNumber: part.partNumber, etag: part.etag, bytes: part.bytes }))
        .sort((left, right) => left.partNumber - right.partNumber),
    };
  }

  async #releaseReservation(userId: string, assetId: string, bytes: number): Promise<void> {
    await db.transaction(async (transaction) => {
      const [entitlement] = await transaction
        .select()
        .from(storageEntitlement)
        .where(eq(storageEntitlement.userId, userId))
        .for("update")
        .limit(1);
      if (entitlement)
        await transaction
          .update(storageEntitlement)
          .set({ reservedBytes: Math.max(0, entitlement.reservedBytes - bytes) })
          .where(eq(storageEntitlement.userId, userId));
      await transaction
        .update(cloudAsset)
        .set({ state: "failed", reservedBytes: 0 })
        .where(eq(cloudAsset.id, assetId));
      await transaction
        .update(cloudUpload)
        .set({ state: "failed" })
        .where(eq(cloudUpload.assetId, assetId));
    });
  }
}
