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

function publicArtifact(artifact: PersistedArtifact): DerivedArtifactSnapshot {
  const {
    relativePath: _relativePath,
    generatorVersion: _version,
    sourceFingerprint: _fingerprint,
    ...value
  } = artifact;
  return structuredClone(value);
}

export function projectDerivedSnapshot(input: {
  project: Project;
  scope: DerivedProjectScope;
  index: PersistedIndex;
  runtime: DerivedRuntimeSnapshot;
}): DerivedMediaSnapshot {
  const assets: Record<string, DerivedAssetSnapshot> = {};
  for (const asset of input.project.assets) {
    const record = input.index.assets[asset.id];
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
  const artifacts = Object.values(assets).flatMap((asset) => [
    asset.thumbnail,
    asset.filmstrip,
    asset.waveform,
    asset.proxy,
  ]);
  return {
    version: 1,
    generatorVersion: DERIVED_GENERATOR_VERSION,
    projectScope: structuredClone(input.scope),
    assets,
    storage: structuredClone(input.index.storage),
    jobs: {
      queued: artifacts.filter((artifact) => artifact.state === "queued").length,
      running: artifacts.filter((artifact) => artifact.state === "running").length,
      completed: artifacts.filter((artifact) => artifact.state === "ready").length,
      failed: artifacts.filter((artifact) => artifact.state === "failed").length,
    },
    runtime: input.runtime,
    decisionLog: structuredClone(input.index.decisionLog),
  };
}
