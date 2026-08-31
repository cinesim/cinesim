import type { CompilerConfig } from "./types";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cinesim.toml must contain a TOML table.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string in cinesim.toml.`);
  }
  return value;
}

function booleanWithDefault(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean in cinesim.toml.`);
  return value;
}

export function parseCompilerConfig(input: unknown): CompilerConfig {
  const value = record(input);
  if (value.version !== 1) throw new Error("cinesim.toml version must be 1.");

  return {
    version: 1,
    entry: requiredString(value.entry, "entry"),
    output: requiredString(value.output ?? ".context/compiler", "output"),
    sourceMaps: booleanWithDefault(value.source_maps, "source_maps", true),
    strict: booleanWithDefault(value.strict, "strict", true),
  };
}
