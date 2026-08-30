import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export class AtomicFileRepository {
  #mutationQueue: Promise<void> = Promise.resolve();

  async readText(path: string, maxBytes: number): Promise<string> {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes)
      throw new Error("Persisted state is outside its size bound");
    return readFile(path, "utf8");
  }

  writeText(
    path: string,
    contents: string,
    options: { maxBytes: number; mode?: number } = { maxBytes: Number.MAX_SAFE_INTEGER },
  ): Promise<void> {
    if (Buffer.byteLength(contents, "utf8") > options.maxBytes)
      return Promise.reject(new Error("Persisted state is outside its size bound"));
    return this.#serialize(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
        await handle.writeFile(contents, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporaryPath, path);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
  }

  remove(path: string): Promise<void> {
    return this.#serialize(async () => {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }

  quarantine(path: string): Promise<void> {
    return this.#serialize(async () => {
      await rename(path, `${path}.corrupt-${randomUUID()}`).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    });
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#mutationQueue.catch(() => undefined).then(operation);
    this.#mutationQueue = result;
    return result;
  }
}
