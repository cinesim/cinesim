import { createIrSourceMap, validateIrProgram, type IrProgram } from "@cinesim/ir";
import { Compilation } from "./binding";
import { CompilerError, fail } from "./compiler-errors";
import type { BoundNode, ModuleRecord } from "./compiler-model";
import { explainBoundNodes, lowerCompositions, referencedAssetIds } from "./lower";
import { compositionElements } from "./module-parser";
import type { CompileResult, CompilerConfig, CompilerHost, SafeCompileResult } from "./types";

export { CompilerError } from "./compiler-errors";

async function bindCompositions(
  compilation: Compilation,
  entry: ModuleRecord,
): Promise<BoundNode[]> {
  const roots: BoundNode[] = [];
  for (const element of compositionElements(entry)) {
    const root = await compilation.compileElement(element, {
      module: entry,
      environment: new Map(),
      prefix: "",
      componentStack: [],
    });
    if (root.kind !== "composition") {
      fail(
        "ROOT_ELEMENT",
        "Exported composition values must be composition elements.",
        root.origin,
      );
    }
    roots.push(root);
  }
  return roots;
}

function buildIr(config: CompilerConfig, roots: readonly BoundNode[]): IrProgram {
  const compositions = lowerCompositions(roots);
  return {
    version: 2,
    languageVersion: config.languageVersion,
    projectId: config.projectId,
    activeCompositionId: config.activeCompositionId,
    compositions,
    referencedAssetIds: referencedAssetIds(compositions),
  };
}

export async function compileVideo(
  entryUri: string,
  config: CompilerConfig,
  host: CompilerHost,
): Promise<CompileResult> {
  const compilation = new Compilation(host, config);
  const entry = await compilation.loadModuleGraph(entryUri);
  const roots = await bindCompositions(compilation, entry);
  const ir = buildIr(config, roots);
  validateIrProgram(ir, new Set(config.assetIds));
  const sources = [...compilation.modules.values()].map((module) => ({
    uri: module.uri,
    revision: module.revision,
  }));
  return {
    ir,
    sourceMap: createIrSourceMap(entryUri, sources, compilation.bindings),
    diagnostics: compilation.diagnostics,
    modules: compilation.moduleSummaries(),
    explanations: explainBoundNodes(roots),
    ast: Object.fromEntries(
      [...compilation.modules.values()].map((module) => [module.uri, module.program]),
    ),
  };
}

export async function compileVideoSafe(
  entryUri: string,
  config: CompilerConfig,
  host: CompilerHost,
): Promise<SafeCompileResult> {
  try {
    return await compileVideo(entryUri, config, host);
  } catch (error) {
    const diagnostic =
      error instanceof CompilerError
        ? error.diagnostic
        : {
            severity: "error" as const,
            code: "COMPILER_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    return { diagnostics: [diagnostic], modules: [], explanations: [], ast: {} };
  }
}
