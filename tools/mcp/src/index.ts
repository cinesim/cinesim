#!/usr/bin/env node
import { resolve } from "node:path";
import { runMcpServer } from "./server";

function projectArgument(arguments_: string[]): string {
  const index = arguments_.indexOf("--project");
  if (index < 0) return process.env.CINESIM_PROJECT ?? process.cwd();
  const value = arguments_[index + 1];
  if (!value) throw new Error("--project requires a directory");
  return value;
}

await runMcpServer(resolve(projectArgument(process.argv.slice(2))));
