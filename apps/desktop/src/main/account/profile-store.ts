import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AccountUser } from "../../shared/api";

const profileSchema = z.object({
  version: z.literal(1),
  user: z.object({
    id: z.string().min(1),
    name: z.string(),
    email: z.email(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
  }),
});

export class DesktopAccountProfileStore {
  #user: AccountUser | null;

  constructor(private readonly path: string) {
    this.#user = this.#read();
  }

  get(): AccountUser | null {
    return this.#user ? structuredClone(this.#user) : null;
  }

  set(user: AccountUser): void {
    this.#user = structuredClone(user);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, user: this.#user }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.path);
  }

  clear(): void {
    this.#user = null;
    try {
      unlinkSync(this.path);
    } catch {
      // Missing or inaccessible profile state must not prevent sign-out.
    }
  }

  #read(): AccountUser | null {
    try {
      return profileSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).user;
    } catch {
      return null;
    }
  }
}
