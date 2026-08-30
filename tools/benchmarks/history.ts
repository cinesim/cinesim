import { performance } from "node:perf_hooks";
import { timeUs, createProject, DEFAULT_TRANSFORM, ProjectHistory } from "@cinesim/core";
import type { Asset, Project } from "@cinesim/core";

const sizes = [100, 1_000, 5_000];
const commandCount = 250;

function projectWithClips(clipCount: number): Project {
  const asset: Asset = {
    id: "asset_benchmark",
    kind: "video",
    name: "benchmark.mp4",
    source: { kind: "local", path: "/benchmark.mp4" },
    durationUs: timeUs(1_000_000),
    width: 1920,
    height: 1080,
  };
  const project = createProject({ name: "History benchmark" });
  project.assets.push(asset);
  project.sequences[0]!.tracks[0]!.clips = Array.from({ length: clipCount }, (_, index) => ({
    id: `clip_benchmark_${String(index).padStart(6, "0")}`,
    assetId: asset.id,
    mediaKind: "video",
    timelineStartUs: timeUs(index * 1_000_000),
    sourceStartUs: timeUs(0),
    sourceEndUs: timeUs(1_000_000),
    transform: DEFAULT_TRANSFORM,
  }));
  return project;
}

for (const clipCount of sizes) {
  const project = projectWithClips(clipCount);
  const clipId = project.sequences[0]!.tracks[0]!.clips[0]!.id;
  const startedAt = performance.now();
  const history = new ProjectHistory(project);
  for (let index = 0; index < commandCount; index += 1) {
    history.commit({
      type: "clip.setFade",
      clipId,
      edge: "in",
      durationUs: timeUs(index * 1_000),
    });
  }
  const elapsedMs = performance.now() - startedAt;
  process.stdout.write(
    `${JSON.stringify({
      clipCount,
      commandCount,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      meanCommandMs: Math.round((elapsedMs / commandCount) * 1_000) / 1_000,
      ...history.stats,
    })}\n`,
  );
}
