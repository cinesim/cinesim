#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import type { AssetId, ClipId } from "@cinesim/core";
import { inspectAsset, inspectProject, inspectTimeline, listAssets } from "@cinesim/protocol";
import { DiskProjectStore } from "./project-store";
import { parseTime } from "./time";

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

const timeline = program.command("timeline").description("Timeline queries");
timeline
  .command("inspect")
  .option("--json", "Emit structured JSON")
  .action(async (options) => {
    const loaded = await store();
    output(inspectTimeline(loaded.project), options.json);
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
  .option("--json")
  .action(async (clipId, options) => {
    const loaded = await store();
    const result = await loaded.execute({
      type: "clip.move",
      clipId: clipId as ClipId,
      timelineStartUs: parseTime(options.to),
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
  process.stderr.write(`cinesim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
