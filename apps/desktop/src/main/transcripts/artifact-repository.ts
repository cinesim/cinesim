import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetId } from "@cinesim/core";
import { stableJson } from "@cinesim/core";
import type { TranscriptArtifact } from "../../shared/transcript";
import { parseTranscriptArtifact } from "./artifact";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

export function validTranscriptAssetId(value: string): value is AssetId {
  return /^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(value);
}

function artifactPath(directory: string, assetId: AssetId): string {
  if (!validTranscriptAssetId(assetId)) throw new Error("Invalid transcript asset ID");
  return join(directory, ".video", "transcripts", `${assetId}.json`);
}

export class TranscriptArtifactRepository {
  async write(directory: string, artifact: TranscriptArtifact, operationId: string): Promise<void> {
    const path = artifactPath(directory, artifact.assetId);
    const temporaryPath = `${path}.${operationId}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, stableJson(artifact), "utf8");
    await rename(temporaryPath, path);
  }

  async read(directory: string, assetId: AssetId): Promise<TranscriptArtifact> {
    const path = artifactPath(directory, assetId);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES)
      throw new Error("Transcript artifact is outside its size bound");
    const artifact = parseTranscriptArtifact(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (artifact.assetId !== assetId) throw new Error("Transcript artifact asset mismatch");
    return artifact;
  }

  async remove(directory: string, assetId: AssetId): Promise<void> {
    await rm(artifactPath(directory, assetId), { force: true });
  }
}
