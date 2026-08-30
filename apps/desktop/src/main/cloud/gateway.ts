import { z } from "zod";
import type { CloudStorageUsage } from "../../shared/contracts";
import {
  MAX_CLOUD_ASSETS_PER_PROJECT,
  MAX_CLOUD_JSON_BYTES,
  MAX_CLOUD_PROJECTS,
  MAX_MULTIPART_PART_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_SIGNED_PARTS_PER_REQUEST,
  MIN_MULTIPART_PART_BYTES,
} from "./limits";

export interface CloudAccountGateway {
  authenticatedFetch(path: string, init?: RequestInit): Promise<Response>;
}

const bytesSchema = z.number().int().nonnegative().safe();
const cloudAssetIdSchema = z.string().regex(/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u);
const cloudUploadIdSchema = z.string().regex(/^cloud_upload_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u);
const cloudStorageUsageSchema = z
  .object({
    includedBytes: bytesSchema,
    addonBytes: bytesSchema,
    usedBytes: bytesSchema,
    reservedBytes: bytesSchema,
    addonOptionsBytes: z.array(bytesSchema).max(32),
    projects: z
      .array(
        z
          .object({
            id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u),
            clientProjectId: z.string().min(1).max(256),
            name: z.string().min(1).max(1_024),
            usedBytes: bytesSchema,
            reservedBytes: bytesSchema,
            assets: z
              .array(
                z
                  .object({
                    id: cloudAssetIdSchema,
                    clientAssetId: z.string().min(1).max(256),
                    name: z.string().min(1).max(1_024),
                    kind: z.enum(["video", "audio", "image"]),
                    bytes: bytesSchema,
                    state: z.enum(["preparing", "uploading", "ready", "failed", "trashed"]),
                    trashedAt: z.iso.datetime().nullable(),
                  })
                  .strict(),
              )
              .max(MAX_CLOUD_ASSETS_PER_PROJECT),
          })
          .strict(),
      )
      .max(MAX_CLOUD_PROJECTS),
  })
  .strict();
const signedR2UrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.endsWith(".r2.cloudflarestorage.com");
}, "Cloud storage returned an invalid signed URL");
const completedPartSchema = z
  .object({
    partNumber: z.number().int().min(1).max(MAX_MULTIPART_PARTS),
    etag: z.string().regex(/^"?[a-fA-F0-9]{32}(?:-\d+)?"?$/u),
    bytes: z.number().int().positive().max(MAX_MULTIPART_PART_BYTES).safe(),
  })
  .strict();
const uploadSchema = z
  .object({
    id: cloudUploadIdSchema,
    cloudAssetId: cloudAssetIdSchema,
    partSize: z.number().int().min(MIN_MULTIPART_PART_BYTES).max(MAX_MULTIPART_PART_BYTES).safe(),
    bytes: z.number().int().positive().safe(),
    expiresAt: z.iso.datetime(),
    state: z.enum(["uploading", "completed", "aborted"]).optional(),
    sourceFingerprint: z.unknown().optional(),
    parts: z.array(completedPartSchema).max(MAX_MULTIPART_PARTS),
  })
  .strict();
const signedPartsSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(MAX_MULTIPART_PARTS),
            url: signedR2UrlSchema,
          })
          .strict(),
      )
      .max(MAX_SIGNED_PARTS_PER_REQUEST),
  })
  .strict();
const downloadSchema = z.object({ url: signedR2UrlSchema, bytes: bytesSchema }).strict();

export type CloudUpload = z.infer<typeof uploadSchema>;
export type SignedUploadPart = z.infer<typeof signedPartsSchema>["parts"][number];

export class CloudStorageGateway {
  constructor(private readonly account: CloudAccountGateway) {}

  usage(): Promise<CloudStorageUsage> {
    return this.#json("/api/v1/cloud/usage", undefined, cloudStorageUsageSchema);
  }

  configureAddon(addonBytes: number): Promise<CloudStorageUsage> {
    return this.#json(
      "/api/v1/cloud/usage",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addonBytes }),
      },
      cloudStorageUsageSchema,
    );
  }

  createUpload(input: unknown): Promise<CloudUpload> {
    return this.#json(
      "/api/v1/cloud/uploads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      uploadSchema,
    );
  }

  upload(uploadId: string): Promise<CloudUpload> {
    return this.#json(
      `/api/v1/cloud/uploads/${encodeURIComponent(uploadId)}`,
      undefined,
      uploadSchema,
    );
  }

  async signParts(
    uploadId: string,
    requestedPartNumbers: readonly number[],
    signal: AbortSignal,
  ): Promise<SignedUploadPart[]> {
    if (
      requestedPartNumbers.length === 0 ||
      requestedPartNumbers.length > MAX_SIGNED_PARTS_PER_REQUEST
    )
      throw new Error("Invalid signed part request");
    const response = await this.#json(
      `/api/v1/cloud/uploads/${encodeURIComponent(uploadId)}/parts/sign`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partNumbers: requestedPartNumbers }),
        signal,
      },
      signedPartsSchema,
    );
    const requested = [...new Set(requestedPartNumbers)].toSorted((left, right) => left - right);
    const received = response.parts
      .map((part) => part.partNumber)
      .toSorted((left, right) => left - right);
    if (
      requested.length !== received.length ||
      requested.some((part, index) => part !== received[index])
    )
      throw new Error("Cloud storage signed an unexpected multipart set");
    return response.parts;
  }

  async recordPart(
    uploadId: string,
    part: { partNumber: number; etag: string; bytes: number },
    signal: AbortSignal,
  ): Promise<void> {
    completedPartSchema.parse(part);
    await this.#response(
      `/api/v1/cloud/uploads/${encodeURIComponent(uploadId)}/parts/${part.partNumber}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ etag: part.etag, bytes: part.bytes }),
        signal,
      },
    );
  }

  async completeUpload(uploadId: string, signal: AbortSignal): Promise<void> {
    await this.#response(`/api/v1/cloud/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: "POST",
      signal,
    });
  }

  async abortUpload(uploadId: string): Promise<void> {
    await this.#response(`/api/v1/cloud/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
    });
  }

  async download(cloudAssetId: string): Promise<{ url: string; bytes: number; expiresAt: number }> {
    const value = await this.#json(
      `/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}/download`,
      { method: "POST" },
      downloadSchema,
    );
    return { ...value, expiresAt: signedUrlExpiry(value.url) };
  }

  async trash(cloudAssetId: string): Promise<void> {
    await this.#response(`/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}/trash`, {
      method: "POST",
    });
  }

  async restore(cloudAssetId: string): Promise<void> {
    await this.#response(`/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}/restore`, {
      method: "POST",
    });
  }

  async delete(cloudAssetId: string): Promise<void> {
    await this.#response(`/api/v1/cloud/assets/${encodeURIComponent(cloudAssetId)}`, {
      method: "DELETE",
    });
  }

  async #json<T>(path: string, init: RequestInit | undefined, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#response(path, init);
    return schema.parse(await readBoundedJson(response));
  }

  async #response(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.account.authenticatedFetch(path, init);
    if (!response.ok) throw new Error(`Cloud service request failed (${response.status})`);
    return response;
  }
}

function signedUrlExpiry(value: string): number {
  const url = new URL(value);
  const encodedDate = url.searchParams.get("X-Amz-Date");
  const expiresSeconds = Number(url.searchParams.get("X-Amz-Expires"));
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(encodedDate ?? "");
  if (
    !match ||
    !Number.isSafeInteger(expiresSeconds) ||
    expiresSeconds < 1 ||
    expiresSeconds > 86_400
  )
    throw new Error("Cloud storage returned a signed URL without a valid expiry");
  const [, year, month, day, hour, minute, second] = match;
  const signedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(signedAt))
    throw new Error("Cloud storage returned an invalid signed expiry");
  return signedAt + expiresSeconds * 1_000;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CLOUD_JSON_BYTES)
    throw new Error("Cloud service response exceeded its size limit");
  if (!response.body) throw new Error("Cloud service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > MAX_CLOUD_JSON_BYTES) {
      await reader.cancel();
      throw new Error("Cloud service response exceeded its size limit");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}
