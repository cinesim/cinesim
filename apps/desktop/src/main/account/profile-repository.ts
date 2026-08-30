import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AccountUser } from "../../shared/contracts";

const MAX_PROFILE_BYTES = 256 * 1024;
const profileSchema = z
  .object({
    version: z.literal(1),
    user: z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().max(1_024),
        email: z.email().max(1_024),
        emailVerified: z.boolean(),
        image: z.string().max(8_192).nullable(),
      })
      .strict(),
  })
  .strict();

export class AccountProfileRepository {
  #user: AccountUser | null;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.#user = this.#read();
  }

  get(): AccountUser | null {
    return this.#user ? structuredClone(this.#user) : null;
  }

  set(user: AccountUser): Promise<void> {
    const storedUser = structuredClone(user);
    this.#user = storedUser;
    return this.#serialize(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: 1, user: storedUser }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await rename(temporaryPath, this.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
  }

  clear(): Promise<void> {
    this.#user = null;
    return this.#serialize(async () => {
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }

  #read(): AccountUser | null {
    try {
      const metadata = statSync(this.path);
      if (!metadata.isFile() || metadata.size > MAX_PROFILE_BYTES) return null;
      return profileSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).user;
    } catch {
      return null;
    }
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#writeQueue.catch(() => undefined).then(operation);
    this.#writeQueue = result;
    return result;
  }
}
