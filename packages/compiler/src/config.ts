import type { CompilerBudgets, CompilerConfig } from "./types";

export const DEFAULT_COMPILER_BUDGETS: CompilerBudgets = {
  maxModules: 128,
  maxSourceBytes: 2_000_000,
  maxComponentDepth: 32,
  maxExpansionNodes: 100_000,
  maxDiagnostics: 100,
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function booleanValue(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

/** Parses the compiler-facing portion of a complete cinesim.toml value. */
export function parseCompilerConfig(
  input: unknown,
  assetIds: readonly string[] = [],
): CompilerConfig {
  const value = record(input, "cinesim.toml");
  if (value.format_version === 2)
    throw new Error(
      "Unsupported Cinesim project format 2. This build requires format 3 with a separate assets.toml file.",
    );
  if (value.format_version !== 3) throw new Error("cinesim.toml format_version must be 3.");
  if (value.language_version !== 1) throw new Error("cinesim.toml language_version must be 1.");
  const project = record(value.project, "project");
  const compiler = value.compiler === undefined ? {} : record(value.compiler, "compiler");
  return {
    languageVersion: 1,
    projectId: requiredString(project.id, "project.id"),
    activeCompositionId: requiredString(project.active_composition, "project.active_composition"),
    entry: requiredString(project.entry, "project.entry"),
    output: ".video/compiler",
    sourceMaps: true,
    strict: booleanValue(compiler.strict, "compiler.strict", true),
    assetIds: [...assetIds].sort((left, right) => left.localeCompare(right)),
    budgets: DEFAULT_COMPILER_BUDGETS,
  };
}
