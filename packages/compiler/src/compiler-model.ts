import type {
  BindingKind,
  ComponentFrame,
  IrEditTarget,
  IrTimeUs,
  IrValue,
  SourceSpan,
} from "@cinesim/ir";
import type { AstNode } from "./ast";
import type { CompilerSource } from "./types";

export interface ImportBinding {
  local: string;
  imported: string;
  source: string;
}

export interface ModuleRecord extends CompilerSource {
  uri: string;
  program: AstNode;
  imports: Map<string, ImportBinding>;
  components: Map<string, AstNode>;
  variables: Map<string, AstNode>;
  compositionExports: Map<string, AstNode>;
  defaultExport?: AstNode;
}

export interface AttributeValue {
  value: IrValue;
  bindingKind: BindingKind;
  readSpan: SourceSpan;
  writeProperty?: string;
  edit?: IrEditTarget;
  insertion?: { source: SourceSpan; beforeOffset: number };
}

export interface BoundKeyframe {
  at: IrTimeUs;
  value: IrValue;
  easing: string;
  origin: SourceSpan;
  edits: { at: IrEditTarget; value: IrEditTarget; easing?: IrEditTarget };
}

export interface BoundAnimation {
  property: string;
  keyframes: BoundKeyframe[];
  origin: SourceSpan;
}

export interface BoundNode {
  id: string;
  kind: string;
  origin: SourceSpan;
  opening: SourceSpan;
  childrenSpan: SourceSpan;
  insertionOffset: number;
  componentStack: ComponentFrame[];
  props: Record<string, AttributeValue>;
  animations: BoundAnimation[];
  children: BoundNode[];
}

export interface CompileContext {
  module: ModuleRecord;
  environment: Map<string, AttributeValue>;
  prefix: string;
  componentStack: ComponentFrame[];
}
