import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class AgentSessionStore {
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<unknown> {
    return JSON.parse(await readFile(this.path, "utf8")) as unknown;
  }

  async write(value: unknown): Promise<void> {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const write = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temporaryPath = `${this.path}.tmp`;
        await writeFile(temporaryPath, contents, "utf8");
        await rename(temporaryPath, this.path);
      });
    this.#writeQueue = write;
    await write;
  }
}
