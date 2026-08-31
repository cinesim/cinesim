import { planSemanticSourceEdits, applySourceEditPlan } from "@cinesim/compiler";
import {
  planSemanticCommand,
  type SemanticCommandPlan,
  type SemanticEditorCommand,
} from "@cinesim/core";
import {
  patchManifestAddAsset,
  patchManifestAssetSource,
  patchManifestProjectKey,
  patchManifestRemoveAsset,
  sourceRevision,
} from "./project-manifest";
import {
  SourceProjectConflictError,
  SourceProjectRepository,
  type SourceProjectSnapshot,
} from "./source-project-repository";

interface SourceHistoryTransaction {
  command: SemanticEditorCommand;
  summary: string;
  before: SourceProjectSnapshot;
  after: SourceProjectSnapshot;
}

export interface SourceCommandResult extends SemanticCommandPlan {
  snapshot: SourceProjectSnapshot;
}

function changedSources(
  current: SourceProjectSnapshot,
  target: SourceProjectSnapshot,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(target.sources).filter(([uri, source]) => current.sources[uri] !== source),
  );
}

function patchManifestForCommand(
  snapshot: SourceProjectSnapshot,
  command: SemanticEditorCommand,
  plan: SemanticCommandPlan,
): string | undefined {
  let source = snapshot.manifestSource;
  let changed = false;
  if (command.type === "asset.import") {
    source = patchManifestAddAsset(source, command.asset, sourceRevision(source));
    changed = true;
  } else if (command.type === "asset.setSource") {
    source = patchManifestAssetSource(
      source,
      command.assetId,
      command.source,
      sourceRevision(source),
    );
    changed = true;
  } else if (command.type === "asset.remove") {
    for (const assetId of command.assetIds) {
      source = patchManifestRemoveAsset(source, assetId, sourceRevision(source));
      changed = true;
    }
  }
  if (plan.manifest.activeCompositionId !== undefined) {
    source = patchManifestProjectKey(
      source,
      "active_composition",
      plan.manifest.activeCompositionId,
      sourceRevision(source),
    );
    changed = true;
  }
  return changed ? source : undefined;
}

export class SourceCommandService {
  readonly #undo: SourceHistoryTransaction[] = [];
  readonly #redo: SourceHistoryTransaction[] = [];
  #snapshot: SourceProjectSnapshot;

  private constructor(
    readonly repository: SourceProjectRepository,
    snapshot: SourceProjectSnapshot,
    private readonly historyLimit = 100,
  ) {
    this.#snapshot = snapshot;
  }

  static async open(directory: string, historyLimit = 100): Promise<SourceCommandService> {
    const repository = await SourceProjectRepository.open(directory);
    return new SourceCommandService(repository, await repository.load(), historyLimit);
  }

  get snapshot(): SourceProjectSnapshot {
    return this.#snapshot;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  async refresh(): Promise<SourceProjectSnapshot> {
    this.#snapshot = await this.repository.load();
    return this.#snapshot;
  }

  /** Accepts a watcher-validated external snapshot and invalidates local source history. */
  acceptExternal(snapshot: SourceProjectSnapshot): void {
    if (snapshot.generation === this.#snapshot.generation) return;
    this.#snapshot = snapshot;
    this.#undo.length = 0;
    this.#redo.length = 0;
  }

  async execute(
    command: SemanticEditorCommand,
    expectedGeneration = this.#snapshot.generation,
  ): Promise<SourceCommandResult> {
    if (expectedGeneration !== this.#snapshot.generation) {
      throw new SourceProjectConflictError(expectedGeneration, this.#snapshot.generation);
    }
    const before = this.#snapshot;
    const plan = planSemanticCommand(before.compilation.ir, before.manifest.assets, command);
    const sourcePlan = planSemanticSourceEdits(
      plan.patches,
      before.compilation.sourceMap,
      before.sources,
    );
    const nextSources = applySourceEditPlan(before.sources, sourcePlan, before.revisions);
    const sourceReplacements = Object.fromEntries(
      sourcePlan.touchedUris.map((uri) => [uri, nextSources[uri]!]),
    );
    const manifestSource = patchManifestForCommand(before, command, plan);
    const after = await this.repository.commit({
      expectedGeneration,
      ...(Object.keys(sourceReplacements).length === 0 ? {} : { sources: sourceReplacements }),
      ...(manifestSource === undefined ? {} : { manifestSource }),
      expectedProgram: plan.program,
    });
    this.#snapshot = after;
    this.#undo.push({ command, summary: plan.summary, before, after });
    if (this.#undo.length > this.historyLimit) this.#undo.shift();
    this.#redo.length = 0;
    return { ...plan, snapshot: after };
  }

  async undo(): Promise<SourceProjectSnapshot> {
    const transaction = this.#undo.at(-1);
    if (!transaction) throw new Error("Nothing to undo.");
    if (this.#snapshot.generation !== transaction.after.generation) {
      throw new SourceProjectConflictError(transaction.after.generation, this.#snapshot.generation);
    }
    const snapshot = await this.repository.commit({
      expectedGeneration: this.#snapshot.generation,
      ...(this.#snapshot.manifestSource === transaction.before.manifestSource
        ? {}
        : { manifestSource: transaction.before.manifestSource }),
      sources: changedSources(this.#snapshot, transaction.before),
      expectedProgram: transaction.before.compilation.ir,
    });
    this.#undo.pop();
    this.#redo.push(transaction);
    this.#snapshot = snapshot;
    return snapshot;
  }

  async redo(): Promise<SourceProjectSnapshot> {
    const transaction = this.#redo.at(-1);
    if (!transaction) throw new Error("Nothing to redo.");
    const snapshot = await this.repository.commit({
      expectedGeneration: this.#snapshot.generation,
      ...(this.#snapshot.manifestSource === transaction.after.manifestSource
        ? {}
        : { manifestSource: transaction.after.manifestSource }),
      sources: changedSources(this.#snapshot, transaction.after),
      expectedProgram: transaction.after.compilation.ir,
    });
    this.#redo.pop();
    this.#undo.push({ ...transaction, before: this.#snapshot, after: snapshot });
    this.#snapshot = snapshot;
    return snapshot;
  }
}
