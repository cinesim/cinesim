import type { IrDiagnostic, IrEditMap, IrProgram } from "@cinesim/ir";

export interface CompilerBudgets {
  maxModules: number;
  maxSourceBytes: number;
  maxComponentDepth: number;
  maxExpansionNodes: number;
  maxDiagnostics: number;
}

export interface CompilerConfig {
  languageVersion: 1;
  projectId: string;
  activeCompositionId: string;
  entry: string;
  output: string;
  sourceMaps: boolean;
  strict: boolean;
  assetIds: string[];
  budgets: CompilerBudgets;
}

export interface CompilerSource {
  source: string;
  revision: string;
}

export interface CompilerHost {
  read(uri: string): Promise<CompilerSource>;
  resolve(specifier: string, importer: string): Promise<string>;
}

export interface CompilerModuleSummary {
  uri: string;
  revision: string;
  imports: Array<{ local: string; imported: string; source: string }>;
  components: string[];
  compositions: string[];
  defaultExport?: string;
}

export interface CompilerExplanation {
  nodeId: string;
  kind: string;
  definedAt: string;
  expandedThrough: string[];
}

export interface CompileResult {
  ir: IrProgram;
  sourceMap: IrEditMap;
  diagnostics: IrDiagnostic[];
  modules: CompilerModuleSummary[];
  explanations: CompilerExplanation[];
  ast: Record<string, unknown>;
}

export interface FailedCompileResult {
  ir?: undefined;
  sourceMap?: undefined;
  diagnostics: IrDiagnostic[];
  modules: CompilerModuleSummary[];
  explanations: CompilerExplanation[];
  ast: Record<string, unknown>;
}

export type SafeCompileResult = CompileResult | FailedCompileResult;
