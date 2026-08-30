import { open } from "node:fs/promises";
import type { CloudStorageGateway, CloudUpload, SignedUploadPart } from "./gateway";
import {
  GLOBAL_PART_CONCURRENCY,
  MAX_MULTIPART_PARTS,
  MAX_SIGNED_PARTS_PER_REQUEST,
} from "./limits";

interface MultipartUploadInput {
  upload: CloudUpload;
  sourcePath: string;
  sourceBytes: number;
  signal: AbortSignal;
  onPartComplete(bytes: number): Promise<void> | void;
}

interface UploadPartInput {
  part: SignedUploadPart;
  upload: CloudUpload;
  sourceBytes: number;
  signal: AbortSignal;
  handle: Awaited<ReturnType<typeof open>>;
  onPartComplete(bytes: number): Promise<void> | void;
}

class GlobalPartSemaphore {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (this.#active < GLOBAL_PART_CONCURRENCY) {
        this.#active += 1;
        resolve();
      } else {
        this.#waiting.push(() => {
          this.#active += 1;
          resolve();
        });
      }
    });
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

export class MultipartUploader {
  readonly #parts = new GlobalPartSemaphore();

  constructor(private readonly gateway: Pick<CloudStorageGateway, "signParts" | "recordPart">) {}

  async upload(input: MultipartUploadInput): Promise<void> {
    const { upload, sourceBytes, signal } = input;
    if (upload.bytes !== sourceBytes) throw new Error("Cloud upload size did not match the source");
    const partCount = Math.ceil(sourceBytes / upload.partSize);
    if (partCount < 1 || partCount > MAX_MULTIPART_PARTS)
      throw new Error("Cloud upload exceeded the multipart count limit");
    const completeParts = validateCompletedParts(upload, partCount, sourceBytes);
    const handle = await open(input.sourcePath, "r");
    try {
      const missing = Array.from({ length: partCount }, (_, index) => index + 1).filter(
        (partNumber) => !completeParts.has(partNumber),
      );
      for (let offset = 0; offset < missing.length; offset += MAX_SIGNED_PARTS_PER_REQUEST) {
        signal.throwIfAborted();
        const requested = missing.slice(offset, offset + MAX_SIGNED_PARTS_PER_REQUEST);
        const signed = await this.gateway.signParts(upload.id, requested, signal);
        await Promise.all(
          signed.map((part) =>
            this.#parts.run(signal, () =>
              this.#uploadPart({
                part,
                upload,
                sourceBytes,
                signal,
                handle,
                onPartComplete: (bytes) => input.onPartComplete(bytes),
              }),
            ),
          ),
        );
      }
    } finally {
      await handle.close();
    }
  }

  async #uploadPart(input: UploadPartInput): Promise<void> {
    const position = (input.part.partNumber - 1) * input.upload.partSize;
    const length = Math.min(input.upload.partSize, input.sourceBytes - position);
    if (length <= 0) throw new Error("Cloud storage signed an out-of-range multipart part");
    const buffer = Buffer.allocUnsafe(length);
    const read = await input.handle.read(buffer, 0, length, position);
    if (read.bytesRead !== length) throw new Error("The source media changed during upload");
    const response = await fetch(input.part.url, {
      method: "PUT",
      body: buffer,
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Cloud part upload failed (${response.status})`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("Cloud part upload did not return an ETag");
    await this.gateway.recordPart(
      input.upload.id,
      { partNumber: input.part.partNumber, etag, bytes: length },
      input.signal,
    );
    await input.onPartComplete(length);
  }
}

function validateCompletedParts(
  upload: CloudUpload,
  partCount: number,
  sourceBytes: number,
): Set<number> {
  const completed = new Set<number>();
  let uploadedBytes = 0;
  for (const part of upload.parts) {
    if (part.partNumber > partCount || completed.has(part.partNumber))
      throw new Error("Cloud upload returned invalid completed parts");
    const expectedBytes =
      part.partNumber === partCount
        ? sourceBytes - upload.partSize * (partCount - 1)
        : upload.partSize;
    if (part.bytes !== expectedBytes) throw new Error("Cloud upload returned an invalid part size");
    completed.add(part.partNumber);
    uploadedBytes += part.bytes;
  }
  if (uploadedBytes > sourceBytes)
    throw new Error("Cloud upload progress exceeded the source size");
  return completed;
}
