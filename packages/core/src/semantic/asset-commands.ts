import { CommandError } from "../commands/types";
import { assertUnlocked, finishCommand } from "./command-helpers";
import type { AssetCommand, CommandContext, SemanticCommandPlan } from "./command-types";

function importAsset(
  context: CommandContext,
  command: Extract<AssetCommand, { type: "asset.import" }>,
): SemanticCommandPlan {
  if (context.assetsById.has(command.asset.id)) {
    throw new CommandError("DUPLICATE_ID", `Asset already exists: ${command.asset.id}`);
  }
  return finishCommand(context, command, `Imported ${command.asset.name}`, [command.asset.id], {
    assets: [...context.assets, command.asset],
    createdIds: [command.asset.id],
  });
}

function setAssetSource(
  context: CommandContext,
  command: Extract<AssetCommand, { type: "asset.setSource" }>,
): SemanticCommandPlan {
  if (!context.assetsById.has(command.assetId)) {
    throw new CommandError("ASSET_NOT_FOUND", `Asset not found: ${command.assetId}`);
  }
  return finishCommand(context, command, `Relinked ${command.assetId}`, [command.assetId]);
}

function removeAssets(
  context: CommandContext,
  command: Extract<AssetCommand, { type: "asset.remove" }>,
): SemanticCommandPlan {
  const selected = new Set<string>(command.assetIds);
  const changed: string[] = [...command.assetIds];
  for (const composition of context.program.compositions) {
    for (const track of composition.timeline.tracks) {
      const removed = track.clips.filter(
        (clip) => clip.assetId !== undefined && selected.has(clip.assetId),
      );
      if (removed.length === 0) continue;
      assertUnlocked(track);
      track.clips = track.clips.filter((clip) => !removed.includes(clip));
      for (const clip of removed) {
        context.patches.push({ type: "node.remove", nodeId: clip.id });
        changed.push(clip.id, track.id, composition.id);
      }
    }
  }
  return finishCommand(
    context,
    command,
    `Removed ${command.assetIds.length} ${command.assetIds.length === 1 ? "asset" : "assets"}`,
    changed,
    { assets: context.assets.filter((asset) => !selected.has(asset.id)) },
  );
}

export function planAssetCommand(
  context: CommandContext,
  command: AssetCommand,
): SemanticCommandPlan {
  switch (command.type) {
    case "asset.import":
      return importAsset(context, command);
    case "asset.setSource":
      return setAssetSource(context, command);
    case "asset.remove":
      return removeAssets(context, command);
  }
}
