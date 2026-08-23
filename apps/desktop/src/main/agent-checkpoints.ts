import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function safeSegment(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export class AgentCheckpointStore {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectDirectory: string) {}

  ref(sessionId: string, turnNumber: number, side: "before" | "after"): string {
    return `refs/cinesim/checkpoints/${safeSegment(sessionId)}/turn/${turnNumber}/${side}`;
  }

  capture(ref: string): Promise<void> {
    return this.#serialize(async () => {
      const { gitDirectory, indexPath } = await this.#prepare();
      const environment = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_WORK_TREE: this.projectDirectory,
        GIT_INDEX_FILE: indexPath,
        GIT_AUTHOR_NAME: "Cinesim",
        GIT_AUTHOR_EMAIL: "checkpoints@cinesim.local",
        GIT_COMMITTER_NAME: "Cinesim",
        GIT_COMMITTER_EMAIL: "checkpoints@cinesim.local",
      };
      try {
        await this.#git(["read-tree", "--empty"], environment);
        await this.#git(["add", "-A", "--", "cinesim.json", ".cinesim"], environment);
        const tree = (await this.#git(["write-tree"], environment)).trim();
        const commit = (
          await this.#git(["commit-tree", tree, "-m", `cinesim checkpoint ${ref}`], environment)
        ).trim();
        await this.#git(["update-ref", ref, commit], environment);
      } finally {
        await rm(indexPath, { force: true });
      }
    });
  }

  restore(ref: string): Promise<void> {
    return this.#serialize(async () => {
      const { gitDirectory, indexPath } = await this.#prepare();
      const environment = {
        ...process.env,
        GIT_DIR: gitDirectory,
        GIT_WORK_TREE: this.projectDirectory,
        GIT_INDEX_FILE: indexPath,
      };
      try {
        await this.#git(["read-tree", ref], environment);
        await this.#git(["clean", "-fdx", "--", "cinesim.json", ".cinesim"], environment);
        await this.#git(["checkout-index", "-a", "-f"], environment);
      } finally {
        await rm(indexPath, { force: true });
      }
    });
  }

  async diffSummary(beforeRef: string, afterRef: string): Promise<string> {
    const { gitDirectory } = await this.#prepare();
    const output = await this.#git(
      ["diff", "--stat", "--no-color", `${beforeRef}^{commit}`, `${afterRef}^{commit}`],
      { ...process.env, GIT_DIR: gitDirectory, GIT_WORK_TREE: this.projectDirectory },
    );
    return output.trim() || "No canonical project changes";
  }

  async #prepare(): Promise<{ gitDirectory: string; indexPath: string }> {
    const runtimeDirectory = join(this.projectDirectory, ".video", "runtime");
    const gitDirectory = join(runtimeDirectory, "agent-checkpoints.git");
    const indexPath = join(runtimeDirectory, `checkpoint-index-${crypto.randomUUID()}`);
    await mkdir(runtimeDirectory, { recursive: true });
    try {
      await execFileAsync("git", ["--git-dir", gitDirectory, "rev-parse", "--is-bare-repository"]);
    } catch {
      await execFileAsync("git", ["init", "--bare", gitDirectory]);
    }
    return { gitDirectory, indexPath };
  }

  async #git(arguments_: string[], environment: NodeJS.ProcessEnv): Promise<string> {
    const result = await execFileAsync("git", arguments_, {
      cwd: this.projectDirectory,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result;
    return result;
  }
}
