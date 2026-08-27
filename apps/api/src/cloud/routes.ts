import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth";
import { CloudStorageError, type CloudStorageService } from "./service";

const cloudProjectId = z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
const cloudAssetId = z.string().regex(/^cloud_asset_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
const cloudUploadId = z.string().regex(/^cloud_upload_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
const clientProjectId = z.string().regex(/^project_[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const clientAssetId = z.string().regex(/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

const projectInput = z.object({
  cloudProjectId: cloudProjectId.optional(),
  clientProjectId,
  name: z.string().trim().min(1).max(120),
});

const uploadInput = z.object({
  cloudProjectId,
  clientAssetId,
  name: z.string().trim().min(1).max(1_024),
  kind: z.enum(["video", "audio", "image"]),
  contentType: z.string().trim().min(1).max(255),
  bytes: z
    .number()
    .int()
    .positive()
    .safe()
    .max(5 * 1024 ** 4),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.object({
    size: z.number().int().positive().safe(),
    mtimeMs: z.number().nonnegative().finite(),
    edgeHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

const signPartsInput = z.object({
  partNumbers: z.array(z.number().int().positive()).min(1).max(16),
});

const completedPartInput = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1).max(255),
  bytes: z.number().int().positive().safe(),
});

async function authenticatedUserId(headers: Headers): Promise<string | null> {
  return (await auth.api.getSession({ headers }))?.user.id ?? null;
}

export function createCloudRoutes(service: CloudStorageService | null) {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use("*", async (context, next) => {
    const userId = await authenticatedUserId(context.req.raw.headers);
    if (!userId) return context.json({ error: "unauthorized" }, 401);
    context.set("userId", userId);
    if (!service) return context.json({ error: "cloud_storage_unavailable" }, 503);
    await next();
  });

  routes.get("/usage", async (context) =>
    context.json(await service!.usage(context.get("userId"))),
  );

  routes.post("/projects", async (context) => {
    const input = projectInput.parse(await context.req.json());
    return context.json(await service!.ensureProject(context.get("userId"), input));
  });

  routes.post("/uploads", async (context) => {
    const input = uploadInput.parse(await context.req.json());
    return context.json(await service!.createUpload(context.get("userId"), input), 201);
  });

  routes.get("/uploads/:uploadId", async (context) => {
    const uploadId = cloudUploadId.parse(context.req.param("uploadId"));
    return context.json(await service!.upload(context.get("userId"), uploadId));
  });

  routes.post("/uploads/:uploadId/parts/sign", async (context) => {
    const uploadId = cloudUploadId.parse(context.req.param("uploadId"));
    const input = signPartsInput.parse(await context.req.json());
    return context.json({
      parts: await service!.signParts(context.get("userId"), uploadId, input.partNumbers),
    });
  });

  routes.put("/uploads/:uploadId/parts/:partNumber", async (context) => {
    const uploadId = cloudUploadId.parse(context.req.param("uploadId"));
    const input = completedPartInput.parse({
      ...(await context.req.json()),
      partNumber: Number(context.req.param("partNumber")),
    });
    return context.json(await service!.recordPart(context.get("userId"), uploadId, input));
  });

  routes.post("/uploads/:uploadId/complete", async (context) => {
    const uploadId = cloudUploadId.parse(context.req.param("uploadId"));
    return context.json(await service!.completeUpload(context.get("userId"), uploadId));
  });

  routes.delete("/uploads/:uploadId", async (context) => {
    const uploadId = cloudUploadId.parse(context.req.param("uploadId"));
    await service!.abortUpload(context.get("userId"), uploadId);
    return context.body(null, 204);
  });

  routes.post("/assets/:cloudAssetId/download", async (context) => {
    const assetId = cloudAssetId.parse(context.req.param("cloudAssetId"));
    return context.json(await service!.downloadUrl(context.get("userId"), assetId));
  });

  routes.post("/assets/:cloudAssetId/trash", async (context) => {
    const assetId = cloudAssetId.parse(context.req.param("cloudAssetId"));
    await service!.trashAsset(context.get("userId"), assetId);
    return context.body(null, 204);
  });

  routes.post("/assets/:cloudAssetId/restore", async (context) => {
    const assetId = cloudAssetId.parse(context.req.param("cloudAssetId"));
    await service!.restoreAsset(context.get("userId"), assetId);
    return context.body(null, 204);
  });

  routes.delete("/assets/:cloudAssetId", async (context) => {
    const assetId = cloudAssetId.parse(context.req.param("cloudAssetId"));
    await service!.purgeAsset(context.get("userId"), assetId);
    return context.body(null, 204);
  });

  routes.onError((error, context) => {
    if (error instanceof CloudStorageError)
      return context.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof z.ZodError)
      return context.json({ error: "invalid_request", issues: error.issues }, 400);
    throw error;
  });

  return routes;
}
