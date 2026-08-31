export interface SourcePoint {
  line: number;
  column: number;
  offset: number;
}

export interface SourceSpan {
  uri: string;
  revision: string;
  start: SourcePoint;
  end: SourcePoint;
}

export interface ComponentFrame {
  name: string;
  definition: SourceSpan;
  invocation: SourceSpan;
}

export type IrValue =
  | { kind: "boolean"; value: boolean }
  | { kind: "color"; value: string }
  | { kind: "length"; unit: "px"; value: number }
  | { kind: "number"; value: number }
  | { kind: "resource"; uri: string }
  | { kind: "string"; value: string }
  | { kind: "time"; valueUs: number }
  | { kind: "vector"; values: IrValue[] };

export type IrValueKind = IrValue["kind"];

export interface IrEditTarget {
  expected: IrValueKind;
  source: SourceSpan;
  strategy: "replace-expression" | "replace-jsx-string";
}

export interface IrProperty {
  value: IrValue;
  edit: IrEditTarget;
}

export interface IrKeyframe {
  at: IrValue & { kind: "time" };
  value: IrValue;
  easing: string;
  origin: SourceSpan;
  edits: {
    at: IrEditTarget;
    value: IrEditTarget;
  };
}

export interface IrAnimation {
  property: string;
  keyframes: IrKeyframe[];
  origin: SourceSpan;
}

export interface IrNode {
  id: string;
  kind: string;
  origin: SourceSpan;
  componentStack: ComponentFrame[];
  props: Record<string, IrProperty>;
  animations: IrAnimation[];
  children: IrNode[];
}

export interface IrDocument {
  version: 1;
  entry: string;
  sources: Array<{ uri: string; revision: string }>;
  root: IrNode;
}

export interface IrDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  source?: SourceSpan;
}

export interface IrSourceMapProperty {
  source: SourceSpan;
  expected: IrValueKind;
  strategy: IrEditTarget["strategy"];
}

export interface IrSourceMapNode {
  origin: SourceSpan;
  componentStack: ComponentFrame[];
  properties: Record<string, IrSourceMapProperty>;
  animations: Array<{
    property: string;
    origin: SourceSpan;
    keyframes: Array<{
      origin: SourceSpan;
      at: IrSourceMapProperty;
      value: IrSourceMapProperty;
    }>;
  }>;
}

export interface IrSourceMap {
  version: 1;
  entry: string;
  nodes: Record<string, IrSourceMapNode>;
}

export interface EvaluatedIrNode {
  id: string;
  kind: string;
  props: Record<string, IrValue>;
  children: EvaluatedIrNode[];
}
