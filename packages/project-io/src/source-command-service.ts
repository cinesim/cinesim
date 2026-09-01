import { planSemanticSourceEdits, applySourceEditPlan } from "@cinesim/compiler";
import {
  planSemanticCommand,
  type SemanticCommandPlan,
  type SemanticEditorCommand,
} from "@cinesim/core";
import {
  patchAssetManifestAdd,
  patchAssetManifestRemove,
  patchAssetManifestSource,
} from "./asset-manifest";
import { patchManifestProjectKey, sourceRevision } from "./project-manifest";
import {
  SourceProjectConflictError,
  SourceProjectRepository,
  type SourceProjectSnapshot,
} from "./source-project-repository";

interface SourceHistoryEntry {
  before: SourceProjectSnapshot;
  after: SourceProjectSnapshot;
}

export interface SourceCommandResult extends SemanticCommandPlan {
  snapshot: SourceProjectSnapshot;
}

function changedSources(
  current: SourceProjectSnapshot,
  target: SourceProjectSnapshot,
): Record<string, string | null> {
  const paths = new Set([...Object.keys(current.sources), ...Object.keys(target.sources)]);
  return Object.fromEntries(
    [...paths]
      .filter((uri) => current.sources[uri] !== target.sources[uri])
      .map((uri) => [uri, target.sources[uri] ?? null]),
  );
}

function patchDocumentsForCommand(
  snapshot: SourceProjectSnapshot,
  command: SemanticEditorCommand,
  plan: SemanticCommandPlan,
): { manifestSource?: string; assetManifestSource?: string } {
  let manifestSource = snapshot.manifestSource;
  let assetManifestSource = snapshot.assetManifestSource;
  let manifestChanged = false;
  let assetsChanged = false;
  if (command.type === "asset.import") {
    assetManifestSource = patchAssetManifestAdd(
      assetManifestSource,
      command.asset,
      sourceRevision(assetManifestSource),
    );
    assetsChanged = true;
  } else if (command.type === "asset.setSource") {
    assetManifestSource = patchAssetManifestSource(
      assetManifestSource,
      command.assetId,
      command.source,
      sourceRevision(assetManifestSource),
    );
    assetsChanged = true;
  } else if (command.type === "asset.remove") {
    for (const assetId of command.assetIds) {
      assetManifestSource = patchAssetManifestRemove(
        assetManifestSource,
        assetId,
        sourceRevision(assetManifestSource),
      );
      assetsChanged = true;
    }
  }
  if (plan.manifest.activeCompositionId !== undefined) {
    manifestSource = patchManifestProjectKey(
      manifestSource,
      "active_composition",
      plan.manifest.activeCompositionId,
      sourceRevision(manifestSource),
    );
    manifestChanged = true;
  }
  return {
    ...(manifestChanged ? { manifestSource } : {}),
    ...(assetsChanged ? { assetManifestSource } : {}),
  };
}

export class SourceCommandService {
  readonly #undo: SourceHistoryEntry[] = [];
  readonly #redo: SourceHistoryEntry[] = [];
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

  /** Records a watcher-validated generation in the same project-wide history as UI commands. */
  acceptExternal(snapshot: SourceProjectSnapshot): void {
    if (snapshot.generation === this.#snapshot.generation) return;
    this.#undo.push({ before: this.#snapshot, after: snapshot });
    if (this.#undo.length > this.historyLimit) this.#undo.shift();
    this.#redo.length = 0;
    this.#snapshot = snapshot;
  }

  async execute(
    command: SemanticEditorCommand,
    expectedGeneration = this.#snapshot.generation,
  ): Promise<SourceCommandResult> {
    if (expectedGeneration !== this.#snapshot.generation) {
      throw new SourceProjectConflictError(expectedGeneration, this.#snapshot.generation);
    }
    const before = this.#snapshot;
    const plan = planSemanticCommand(before.compilation.ir, before.assets, command);
    const sourcePlan = planSemanticSourceEdits(
      plan.patches,
      before.compilation.sourceMap,
      before.sources,
    );
    const nextSources = applySourceEditPlan(before.sources, sourcePlan, before.revisions);
    const sourceReplacements = Object.fromEntries(
      sourcePlan.touchedUris.map((uri) => [uri, nextSources[uri]!]),
    );
    const documentChanges = patchDocumentsForCommand(before, command, plan);
    const after = await this.repository.commit({
      expectedGeneration,
      ...(Object.keys(sourceReplacements).length === 0 ? {} : { sources: sourceReplacements }),
      ...documentChanges,
      expectedProgram: plan.program,
    });
    this.#snapshot = after;
    this.#undo.push({ before, after });
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
      ...(this.#snapshot.assetManifestSource === transaction.before.assetManifestSource
        ? {}
        : { assetManifestSource: transaction.before.assetManifestSource }),
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
      ...(this.#snapshot.assetManifestSource === transaction.after.assetManifestSource
        ? {}
        : { assetManifestSource: transaction.after.assetManifestSource }),
      sources: changedSources(this.#snapshot, transaction.after),
      expectedProgram: transaction.after.compilation.ir,
    });
    this.#redo.pop();
    this.#undo.push({ ...transaction, before: this.#snapshot, after: snapshot });
    this.#snapshot = snapshot;
    return snapshot;
  }
}
