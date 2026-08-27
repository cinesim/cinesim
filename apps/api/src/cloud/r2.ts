import { AwsClient } from "aws4fetch";

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

function encodedObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function xmlValue(source: string, tag: string): string {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(source);
  if (!match?.[1]) throw new Error(`R2 response did not include ${tag}`);
  return match[1];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export class R2ObjectStore {
  readonly #client: AwsClient;
  readonly #endpoint: string;

  constructor(private readonly config: R2Config) {
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 3,
    });
    this.#endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  }

  #objectUrl(key: string): string {
    return `${this.#endpoint}/${encodeURIComponent(this.config.bucket)}/${encodedObjectKey(key)}`;
  }

  async createMultipartUpload(input: {
    key: string;
    contentType: string;
    checksumSha256: string;
  }): Promise<string> {
    const response = await this.#client.fetch(`${this.#objectUrl(input.key)}?uploads=`, {
      method: "POST",
      headers: {
        "Content-Type": input.contentType,
        "x-amz-meta-cinesim-sha256": input.checksumSha256,
      },
    });
    if (!response.ok) throw new Error(`R2 multipart creation failed (${response.status})`);
    return xmlValue(await response.text(), "UploadId");
  }

  async signUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresSeconds?: number;
  }): Promise<string> {
    const url = new URL(this.#objectUrl(input.key));
    url.searchParams.set("partNumber", String(input.partNumber));
    url.searchParams.set("uploadId", input.uploadId);
    url.searchParams.set("X-Amz-Expires", String(input.expiresSeconds ?? 900));
    const request = await this.#client.sign(url, {
      method: "PUT",
      aws: { signQuery: true },
    });
    return request.url;
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: CompletedPart[];
  }): Promise<string> {
    const url = new URL(this.#objectUrl(input.key));
    url.searchParams.set("uploadId", input.uploadId);
    const body = `<CompleteMultipartUpload>${input.parts
      .toSorted((left, right) => left.partNumber - right.partNumber)
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
      )
      .join("")}</CompleteMultipartUpload>`;
    const response = await this.#client.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
    });
    if (!response.ok) throw new Error(`R2 multipart completion failed (${response.status})`);
    return xmlValue(await response.text(), "ETag");
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void> {
    const url = new URL(this.#objectUrl(input.key));
    url.searchParams.set("uploadId", input.uploadId);
    const response = await this.#client.fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404)
      throw new Error(`R2 multipart abort failed (${response.status})`);
  }

  async headObject(key: string): Promise<{ bytes: number; etag: string | null }> {
    const response = await this.#client.fetch(this.#objectUrl(key), { method: "HEAD" });
    if (!response.ok) throw new Error(`R2 object verification failed (${response.status})`);
    const bytes = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("R2 object verification returned an invalid size");
    return { bytes, etag: response.headers.get("etag") };
  }

  async signDownload(key: string, expiresSeconds = 300): Promise<string> {
    const url = new URL(this.#objectUrl(key));
    url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    const request = await this.#client.sign(url, { method: "GET", aws: { signQuery: true } });
    return request.url;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.#client.fetch(this.#objectUrl(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404)
      throw new Error(`R2 object deletion failed (${response.status})`);
  }
}
