import type { IrDiagnostic, IrDocument, IrSourceMap } from "@cinesim/ir";

export interface CompilerConfig {
  version: 1;
  entry: string;
  output: string;
  sourceMaps: boolean;
  strict: boolean;
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
  hasDefaultExport: boolean;
}

export interface CompilerExplanation {
  nodeId: string;
  kind: string;
  definedAt: string;
  expandedThrough: string[];
}

export interface CompileResult {
  ir: IrDocument;
  sourceMap: IrSourceMap;
  diagnostics: IrDiagnostic[];
  modules: CompilerModuleSummary[];
  explanations: CompilerExplanation[];
}
