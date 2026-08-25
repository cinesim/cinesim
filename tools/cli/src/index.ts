#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import type { AssetId, ClipId, SequenceId, Track, TrackId } from "@cinesim/core";
import { createCinesimLogger } from "@cinesim/logging";
import { inspectAsset, inspectProject, inspectTimeline, listAssets } from "@cinesim/protocol";
import { DiskProjectStore } from "./project-store";
import { parseTime } from "./time";

const log = createCinesimLogger({ service: "cli" });

const program = new Command()
  .name("cinesim")
  .description("Inspect and edit a Cinesim project through its canonical command pathway")
  .version("0.1.0")
  .option("-p, --project <directory>", "Cinesim project directory");

function directory(): string {
  return (
    program.opts<{ project?: string }>().project ?? process.env.CINESIM_PROJECT ?? process.cwd()
  );
}

async function store(): Promise<DiskProjectStore> {
  return new DiskProjectStore(directory()).load();
}

function output(value: unknown, asJson = false): void {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean: ${value}. Use true or false.`);
}

function parseIndex(value: string): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid track index: ${value}. Use a non-negative integer.`);
  }
  return index;
}

const project = program.command("project").description("Project operations");
project
  .command("inspect")
  .option("--json", "Emit structured JSON")
  .action(async (options) => {
    const loaded = await store();
    output(
      { ...inspectProject(loaded.project), directory: loaded.directory, settings: loaded.settings },
      options.json,
    );
  });

const assets = program.command("assets").description("Asset collection operations");
assets
  .command("list")
  .option("--json", "Emit structured JSON")
  .action(async (options) => {
    const loaded = await store();
    output(listAssets(loaded.project), options.json);
  });

const asset = program.command("asset").description("Single asset operations");
asset
  .command("inspect")
  .argument("<asset-id>")
  .option("--json", "Emit structured JSON")
  .action(async (assetId, options) => {
    const loaded = await store();
    output(inspectAsset(loaded.project, assetId as AssetId), options.json);
  });
asset
  .command("delete")
  .argument("<asset-ids...>")
  .option("--json")
  .action(async (assetIds: string[], options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "asset.remove",
      assetIds: assetIds as AssetId[],
    });
    output({ summary: result.summary, changedIds: result.changedIds }, options.json);
  });

const timeline = program.command("timeline").description("Timeline operations");
timeline
  .command("inspect")
  .option("--json", "Emit structured JSON")
  .action(async (options) => {
    const loaded = await store();
    output(inspectTimeline(loaded.project), options.json);
  });
timeline
  .command("create-from-assets")
  .argument("<asset-ids...>")
  .option("--name <name>")
  .option("--json")
  .action(async (assetIds: string[], options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "sequence.createFromAssets",
      assetIds: assetIds as AssetId[],
      ...(options.name === undefined ? {} : { name: options.name }),
    });
    output({ summary: result.summary, createdIds: result.createdIds }, options.json);
  });
timeline
  .command("delete")
  .argument("<sequence-id>")
  .option("--json")
  .action(async (sequenceId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "sequence.remove",
      sequenceId: sequenceId as SequenceId,
    });
    output({ summary: result.summary, changedIds: result.changedIds }, options.json);
  });

const track = program.command("track").description("Deterministic track edits");
track
  .command("add")
  .argument("<kind>", "video, audio, or overlay")
  .option("--sequence <sequence-id>", "Target sequence; defaults to the active sequence")
  .option("--name <name>")
  .option("--json")
  .action(async (kind, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "track.add",
      sequenceId: (options.sequence ?? loaded.project.activeSequenceId) as SequenceId,
      kind: kind as Track["kind"],
      ...(options.name === undefined ? {} : { name: options.name }),
    });
    output({ summary: result.summary, createdIds: result.createdIds }, options.json);
  });
track
  .command("update")
  .argument("<track-id>")
  .option("--name <name>")
  .option("--muted <boolean>", "Set mute state", parseBoolean)
  .option("--locked <boolean>", "Set lock state", parseBoolean)
  .option("--json")
  .action(async (trackId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "track.update",
      trackId: trackId as TrackId,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.muted === undefined ? {} : { muted: options.muted }),
      ...(options.locked === undefined ? {} : { locked: options.locked }),
    });
    output({ summary: result.summary, changedIds: result.changedIds }, options.json);
  });
track
  .command("reorder")
  .argument("<track-id>")
  .requiredOption("--index <index>", "Zero-based destination index", parseIndex)
  .option("--json")
  .action(async (trackId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "track.reorder",
      trackId: trackId as TrackId,
      index: options.index,
    });
    output({ summary: result.summary, changedIds: result.changedIds }, options.json);
  });
track
  .command("delete")
  .argument("<track-id>")
  .option("--json")
  .action(async (trackId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "track.remove",
      trackId: trackId as TrackId,
    });
    output({ summary: result.summary, changedIds: result.changedIds }, options.json);
  });

const clip = program.command("clip").description("Deterministic clip edits");
clip
  .command("split")
  .argument("<clip-id>")
  .requiredOption("--at <time>")
  .option("--json")
  .action(async (clipId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "clip.split",
      clipId: clipId as ClipId,
      atUs: parseTime(options.at),
    });
    output({ summary: result.summary, createdIds: result.createdIds }, options.json);
  });
clip
  .command("move")
  .argument("<clip-id>")
  .requiredOption("--to <time>")
  .option("--track <track-id>", "Move to another compatible track")
  .option("--json")
  .action(async (clipId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "clip.move",
      clipId: clipId as ClipId,
      timelineStartUs: parseTime(options.to),
      ...(options.track === undefined ? {} : { trackId: options.track as TrackId }),
    });
    output({ summary: result.summary, changedIds: result.changedIds }, options.json);
  });
clip
  .command("trim-start")
  .argument("<clip-id>")
  .requiredOption("--at <time>")
  .option("--json")
  .action(async (clipId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "clip.trimStart",
      clipId: clipId as ClipId,
      atUs: parseTime(options.at),
    });
    output({ summary: result.summary }, options.json);
  });
clip
  .command("trim-end")
  .argument("<clip-id>")
  .requiredOption("--at <time>")
  .option("--json")
  .action(async (clipId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "clip.trimEnd",
      clipId: clipId as ClipId,
      atUs: parseTime(options.at),
    });
    output({ summary: result.summary }, options.json);
  });
clip
  .command("delete")
  .argument("<clip-id>")
  .option("--json")
  .action(async (clipId, options) => {
    const loaded = await store();
    const result = await loaded.execute({ type: "clip.remove", clipId: clipId as ClipId });
    output({ summary: result.summary }, options.json);
  });

program
  .command("filmstrip")
  .argument("<asset-id>")
  .option("--json")
  .action(async (assetId, options) => {
    const loaded = await store();
    inspectAsset(loaded.project, assetId as AssetId);
    const path = join(loaded.directory, ".video", "filmstrips", `${assetId}.jpg`);
    output({ assetId, path, exists: existsSync(path), derived: true }, options.json);
  });

program
  .command("frame")
  .argument("<asset-id>")
  .requiredOption("--at <time>")
  .option("--json")
  .action(async (assetId, options) => {
    const loaded = await store();
    inspectAsset(loaded.project, assetId as AssetId);
    const atUs = parseTime(options.at);
    const path = join(loaded.directory, ".video", "frames", `${assetId}-${atUs}.png`);
    output({ assetId, atUs, path, exists: existsSync(path), derived: true }, options.json);
  });

program.parseAsync().catch((error: unknown) => {
  log.error({ err: error }, "CLI command failed");
  process.stderr.write(`cinesim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
