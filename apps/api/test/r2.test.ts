import { describe, expect, it } from "vitest";
import { R2ObjectStore } from "../src/cloud/r2";

describe("R2 object store", () => {
  it("creates short-lived part-specific signed upload URLs without exposing the secret", async () => {
    const store = new R2ObjectStore({
      accountId: "account-id",
      bucket: "private-originals",
      accessKeyId: "access-key-id",
      secretAccessKey: "never-expose-this-secret",
    });
    const signed = new URL(
      await store.signUploadPart({
        key: "accounts/storage_123/projects/cloud_project_123/assets/cloud_asset_123/original",
        uploadId: "r2-upload-id",
        partNumber: 7,
        expiresSeconds: 900,
      }),
    );
    expect(signed.protocol).toBe("https:");
    expect(signed.hostname).toBe("account-id.r2.cloudflarestorage.com");
    expect(signed.searchParams.get("partNumber")).toBe("7");
    expect(signed.searchParams.get("uploadId")).toBe("r2-upload-id");
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.toString()).not.toContain("never-expose-this-secret");
  });

  it("creates a read-only signed download URL for one object", async () => {
    const store = new R2ObjectStore({
      accountId: "account-id",
      bucket: "private-originals",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-key",
    });
    const signed = new URL(await store.signDownload("accounts/storage_123/original", 300));
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});
