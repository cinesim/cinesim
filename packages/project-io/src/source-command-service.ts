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
  patchAssetNote,
} from "./asset-manifest";
import { AcceptedProjectHistory, type AcceptedProjectState } from "./accepted-history";
import { patchManifestProjectKey, patchProjectNote, sourceRevision } from "./project-manifest";
import {
  SourceProjectConflictError,
  SourceProjectRepository,
  type SourceProjectSnapshot,
} from "./source-project-repository";

export interface SourceCommandResult extends SemanticCommandPlan {
  snapshot: SourceProjectSnapshot;
}

function changedSources(
  current: SourceProjectSnapshot,
  target: Pick<AcceptedProjectState, "sources">,
): Record<string, string | null> {
  const paths = new Set([...Object.keys(current.sources), ...Object.keys(target.sources)]);
  return Object.fromEntries(
    [...paths]
      .filter((uri) => current.sources[uri] !== target.sources[uri])
      .map((uri) => [uri, target.sources[uri] ?? null]),
  );
}

function editorialNote(command: Extract<SemanticEditorCommand, { type: "note.upsert" }>) {
  const { atUs: _atUs, durationUs: _durationUs, ...note } = command.note;
  return note;
}

function isNoteCommand(
  command: SemanticEditorCommand,
): command is Extract<SemanticEditorCommand, { type: `note.${string}` }> {
  return command.type === "note.upsert" || command.type === "note.remove";
}

function patchAssetDocument(source: string, command: SemanticEditorCommand): string | undefined {
  if (command.type === "asset.import")
    return patchAssetManifestAdd(source, command.asset, sourceRevision(source));
  if (command.type === "asset.setSource")
    return patchAssetManifestSource(
      source,
      command.assetId,
      command.source,
      sourceRevision(source),
    );
  if (command.type === "asset.remove") {
    let next = source;
    for (const assetId of command.assetIds)
      next = patchAssetManifestRemove(next, assetId, sourceRevision(next));
    return next;
  }
  if (!isNoteCommand(command) || command.target !== "asset") return undefined;
  if (!command.assetId) throw new Error("Asset note command is missing assetId");
  return patchAssetNote(
    source,
    command.assetId,
    command.type === "note.upsert" ? command.note.id : command.noteId,
    command.type === "note.upsert" ? editorialNote(command) : null,
    sourceRevision(source),
  );
}

function patchProjectDocument(
  source: string,
  command: SemanticEditorCommand,
  plan: SemanticCommandPlan,
): string | undefined {
  let next = source;
  let changed = false;
  if (isNoteCommand(command) && command.target === "project") {
    next = patchProjectNote(
      next,
      command.type === "note.upsert" ? command.note.id : command.noteId,
      command.type === "note.upsert" ? editorialNote(command) : null,
      sourceRevision(next),
    );
    changed = true;
  }
  if (plan.manifest.activeCompositionId !== undefined) {
    next = patchManifestProjectKey(
      next,
      "active_composition",
      plan.manifest.activeCompositionId,
      sourceRevision(next),
    );
    changed = true;
  }
  return changed ? next : undefined;
}

function patchDocumentsForCommand(
  snapshot: SourceProjectSnapshot,
  command: SemanticEditorCommand,
  plan: SemanticCommandPlan,
): { manifestSource?: string; assetManifestSource?: string } {
  const manifestSource = patchProjectDocument(snapshot.manifestSource, command, plan);
  const assetManifestSource = patchAssetDocument(snapshot.assetManifestSource, command);
  return {
    ...(manifestSource ? { manifestSource } : {}),
    ...(assetManifestSource ? { assetManifestSource } : {}),
  };
}

export class SourceCommandService {
  #snapshot: SourceProjectSnapshot;

  private constructor(
    readonly repository: SourceProjectRepository,
    snapshot: SourceProjectSnapshot,
    private readonly history: AcceptedProjectHistory,
  ) {
    this.#snapshot = snapshot;
  }

  static async open(directory: string, historyLimit = 100): Promise<SourceCommandService> {
    const repository = await SourceProjectRepository.open(directory);
    const snapshot = await repository.load();
    const history = await AcceptedProjectHistory.open(repository, snapshot, historyLimit);
    return new SourceCommandService(repository, snapshot, history);
  }

  get snapshot(): SourceProjectSnapshot {
    return this.#snapshot;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  async refresh(): Promise<SourceProjectSnapshot> {
    const snapshot = await this.repository.load();
    await this.acceptExternal(snapshot);
    return this.#snapshot;
  }

  /** Records a watcher-validated generation in the same project-wide history as UI commands. */
  async acceptExternal(snapshot: SourceProjectSnapshot): Promise<void> {
    if (snapshot.generation === this.#snapshot.generation) return;
    await this.history.append(snapshot);
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
    const plan = planSemanticCommand(
      before.compilation.ir,
      before.assets,
      command,
      before.manifest.notes,
    );
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
    await this.history.append(after);
    return { ...plan, snapshot: after };
  }

  async undo(): Promise<SourceProjectSnapshot> {
    const target = await this.history.destination("undo");
    const snapshot = await this.repository.commit({
      expectedGeneration: this.#snapshot.generation,
      ...(this.#snapshot.manifestSource === target.manifestSource
        ? {}
        : { manifestSource: target.manifestSource }),
      ...(this.#snapshot.assetManifestSource === target.assetManifestSource
        ? {}
        : { assetManifestSource: target.assetManifestSource }),
      sources: changedSources(this.#snapshot, target),
    });
    await this.history.acceptMove("undo", snapshot);
    this.#snapshot = snapshot;
    return snapshot;
  }

  async redo(): Promise<SourceProjectSnapshot> {
    const target = await this.history.destination("redo");
    const snapshot = await this.repository.commit({
      expectedGeneration: this.#snapshot.generation,
      ...(this.#snapshot.manifestSource === target.manifestSource
        ? {}
        : { manifestSource: target.manifestSource }),
      ...(this.#snapshot.assetManifestSource === target.assetManifestSource
        ? {}
        : { assetManifestSource: target.assetManifestSource }),
      sources: changedSources(this.#snapshot, target),
    });
    await this.history.acceptMove("redo", snapshot);
    this.#snapshot = snapshot;
    return snapshot;
  }
}
