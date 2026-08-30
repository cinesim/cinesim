import type { Project } from "@cinesim/core";
import type {
  DerivedArtifactSnapshot,
  DerivedAssetSnapshot,
  DerivedMediaSnapshot,
  DerivedProjectScope,
  DerivedRuntimeSnapshot,
} from "../../shared/contracts";
import { DERIVED_GENERATOR_VERSION } from "./model";
import type { PersistedArtifact, PersistedIndex } from "./model";

type PublicAssetMap = Record<string, DerivedAssetSnapshot>;

function publicArtifact(artifact: PersistedArtifact): DerivedArtifactSnapshot {
  const {
    relativePath: _relativePath,
    generatorVersion: _version,
    sourceFingerprint: _fingerprint,
    ...value
  } = artifact;
  return structuredClone(value);
}

function publicAssets(project: Project, index: PersistedIndex): PublicAssetMap {
  const assets: PublicAssetMap = {};
  for (const asset of project.assets) {
    const record = index.assets[asset.id];
    if (!record) continue;
    assets[asset.id] = {
      assetId: asset.id,
      fingerprintStatus: record.sourceFingerprint.size < 0 ? "missing" : "current",
      thumbnail: publicArtifact(record.thumbnail),
      filmstrip: publicArtifact(record.filmstrip),
      waveform: publicArtifact(record.waveform),
      proxy: publicArtifact(record.proxy),
      performance: structuredClone(record.performance),
    };
  }
  return assets;
}

function jobCounts(assets: PublicAssetMap): DerivedMediaSnapshot["jobs"] {
  const artifacts = Object.values(assets).flatMap((asset) => [
    asset.thumbnail,
    asset.filmstrip,
    asset.waveform,
    asset.proxy,
  ]);
  return {
    queued: artifacts.filter(({ state }) => state === "queued").length,
    running: artifacts.filter(({ state }) => state === "running").length,
    completed: artifacts.filter(({ state }) => state === "ready").length,
    failed: artifacts.filter(({ state }) => state === "failed").length,
  };
}

export function projectDerivedSnapshot(input: {
  project: Project;
  scope: DerivedProjectScope;
  index: PersistedIndex;
  runtime: DerivedRuntimeSnapshot;
}): DerivedMediaSnapshot {
  const assets = publicAssets(input.project, input.index);
  return {
    version: 1,
    generatorVersion: DERIVED_GENERATOR_VERSION,
    projectScope: structuredClone(input.scope),
    assets,
    storage: structuredClone(input.index.storage),
    jobs: jobCounts(assets),
    runtime: input.runtime,
    decisionLog: structuredClone(input.index.decisionLog),
  };
}
