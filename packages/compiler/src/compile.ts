import {
  createIrSourceMap,
  irTimeUs,
  validateIrProgram,
  type BindingKind,
  type ComponentFrame,
  type EditMapBuilderNode,
  type IrAnimation,
  type IrClip,
  type IrComposition,
  type IrDiagnostic,
  type IrEditTarget,
  type IrEffect,
  type IrProgram,
  type IrPropertyBinding,
  type IrSceneNode,
  type IrStructuralBinding,
  type IrTimeUs,
  type IrTrack,
  type IrValue,
  type IrValueKind,
  type SourceSpan,
} from "@cinesim/ir";
import { node, nodes, optionalNode, parseJavaScript, stringField, type AstNode } from "./ast";
import { BUILTIN_REGISTRY, EFFECT_BUILTINS, TEMPORAL_BUILTINS } from "./registry";
import type {
  CompileResult,
  CompilerConfig,
  CompilerExplanation,
  CompilerHost,
  CompilerModuleSummary,
  CompilerSource,
  SafeCompileResult,
} from "./types";

interface ImportBinding {
  local: string;
  imported: string;
  source: string;
}

interface ModuleRecord extends CompilerSource {
  uri: string;
  program: AstNode;
  imports: Map<string, ImportBinding>;
  components: Map<string, AstNode>;
  variables: Map<string, AstNode>;
  compositionExports: Map<string, AstNode>;
  defaultExport?: AstNode;
}

interface AttributeValue {
  value: IrValue;
  bindingKind: BindingKind;
  readSpan: SourceSpan;
  writeProperty?: string;
  edit?: IrEditTarget;
  insertion?: { source: SourceSpan; beforeOffset: number };
}

interface BoundKeyframe {
  at: IrTimeUs;
  value: IrValue;
  easing: string;
  origin: SourceSpan;
  edits: { at: IrEditTarget; value: IrEditTarget };
}

interface BoundAnimation {
  property: string;
  keyframes: BoundKeyframe[];
  origin: SourceSpan;
}

interface BoundNode {
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

interface CompileContext {
  module: ModuleRecord;
  environment: Map<string, AttributeValue>;
  prefix: string;
  componentStack: ComponentFrame[];
}

const COLOR = /^(?:#[\da-f]{3,8}|transparent)$/iu;
const TRACK_KINDS = new Set(["video", "audio", "overlay"]);
const MEDIA_KINDS = new Set(["video", "audio"]);
const TRANSITIONS = new Set(["cut", "dissolve", "dip", "wipe", "slide", "push", "zoom", "blur"]);

export class CompilerError extends Error {
  readonly diagnostic: IrDiagnostic;

  constructor(diagnostic: IrDiagnostic) {
    const location =
      diagnostic.source === undefined
        ? ""
        : `${diagnostic.source.uri}:${diagnostic.source.start.line}:${diagnostic.source.start.column} `;
    super(`${location}[${diagnostic.code}] ${diagnostic.message}`);
    this.name = "CompilerError";
    this.diagnostic = diagnostic;
  }
}

function fail(code: string, message: string, source?: SourceSpan): never {
  throw new CompilerError({
    severity: "error",
    code,
    message,
    ...(source === undefined ? {} : { source }),
  });
}

function literalValue(ast: AstNode): unknown {
  return ast.value;
}

function identifierName(ast: AstNode, description = "identifier"): string {
  if (ast.type !== "Identifier" && ast.type !== "JSXIdentifier")
    throw new Error(`Expected ${description}.`);
  return stringField(ast.name, description);
}

function nodeLocation(module: ModuleRecord, ast: AstNode): SourceSpan {
  const location = ast.loc;
  return {
    uri: module.uri,
    revision: module.revision,
    start: {
      line: location?.start.line ?? 1,
      column: (location?.start.column ?? ast.start) + 1,
      offset: ast.start,
    },
    end: {
      line: location?.end.line ?? 1,
      column: (location?.end.column ?? ast.end) + 1,
      offset: ast.end,
    },
  };
}

function displayLocation(span: SourceSpan): string {
  return `${span.uri}:${span.start.line}:${span.start.column}`;
}

function declarationVariables(declaration: AstNode): Array<{ name: string; value: AstNode }> {
  if (declaration.type !== "VariableDeclaration") return [];
  return nodes(declaration.declarations, "variable declarations").flatMap((declarator) => {
    const id = node(declarator.id, "variable id");
    const value = optionalNode(declarator.init);
    return id.type === "Identifier" && value !== undefined
      ? [{ name: identifierName(id), value }]
      : [];
  });
}

function parseModule(uri: string, loaded: CompilerSource): ModuleRecord {
  let program: AstNode;
  try {
    program = parseJavaScript(loaded.source);
  } catch (error) {
    fail("JS_PARSE", error instanceof Error ? error.message : String(error));
  }
  const module: ModuleRecord = {
    uri,
    ...loaded,
    program,
    imports: new Map(),
    components: new Map(),
    variables: new Map(),
    compositionExports: new Map(),
  };
  for (const statement of nodes(program.body, "module statements")) {
    if (statement.type === "ImportDeclaration") {
      const source = literalValue(node(statement.source, "import source"));
      if (typeof source !== "string")
        fail("IMPORT_SOURCE", "Import sources must be strings.", nodeLocation(module, statement));
      for (const specifier of nodes(statement.specifiers, "import specifiers")) {
        if (specifier.type !== "ImportSpecifier")
          fail(
            "IMPORT_FORM",
            "Only named component imports are supported.",
            nodeLocation(module, specifier),
          );
        const local = identifierName(node(specifier.local, "local import name"));
        const importedNode = node(specifier.imported, "imported name");
        const imported =
          importedNode.type === "Identifier"
            ? identifierName(importedNode)
            : String(literalValue(importedNode));
        module.imports.set(local, { local, imported, source });
      }
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      module.defaultExport = node(statement.declaration, "default export");
      continue;
    }
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? optionalNode(statement.declaration) : statement;
    if (declaration?.type === "FunctionDeclaration") {
      const name = identifierName(node(declaration.id, "component function name"));
      if (name[0] !== name[0]?.toUpperCase())
        fail(
          "COMPONENT_CASE",
          `Component ${name} must be capitalized.`,
          nodeLocation(module, declaration),
        );
      module.components.set(name, declaration);
    }
    if (declaration !== undefined) {
      for (const variable of declarationVariables(declaration)) {
        module.variables.set(variable.name, variable.value);
        if (exported && variable.value.type === "JSXElement")
          module.compositionExports.set(variable.name, variable.value);
      }
    }
    if (exported && declaration === undefined) {
      for (const specifier of nodes(statement.specifiers, "export specifiers")) {
        const local = identifierName(node(specifier.local, "export local"));
        const exportedName = identifierName(node(specifier.exported, "export name"));
        const value = module.variables.get(local);
        if (value?.type === "JSXElement") module.compositionExports.set(exportedName, value);
      }
    }
  }
  return module;
}

function openingElement(ast: AstNode): AstNode {
  return node(ast.openingElement, "JSX opening element");
}

function closingElement(ast: AstNode): AstNode | undefined {
  return optionalNode(ast.closingElement);
}

function jsxElementName(ast: AstNode): string {
  const name = node(openingElement(ast).name, "JSX element name");
  if (name.type !== "JSXIdentifier")
    throw new Error("Namespaced and member JSX names are not supported.");
  return identifierName(name, "JSX element name");
}

function attributes(ast: AstNode): AstNode[] {
  return nodes(openingElement(ast).attributes, "JSX attributes");
}

function jsxChildren(ast: AstNode): AstNode[] {
  return nodes(ast.children, "JSX children");
}

function jsxAttributeName(ast: AstNode): string {
  return identifierName(node(ast.name, "JSX attribute name"), "JSX attribute name");
}

function expressionValue(
  value: IrValue,
  source: SourceSpan,
  bindingKind: BindingKind = "direct",
): AttributeValue {
  return {
    value,
    bindingKind,
    readSpan: source,
    edit: { expected: value.kind, source, strategy: "replace-expression" },
  };
}

function numberArgument(value: IrValue, helper: string): number {
  if (value.kind !== "number" || !Number.isFinite(value.value))
    throw new Error(`${helper} expects a finite number.`);
  return value.value;
}

function typedNumber(value: IrValue): number | undefined {
  if (
    value.kind === "number" ||
    value.kind === "length" ||
    value.kind === "angle" ||
    value.kind === "decibels" ||
    value.kind === "percent"
  )
    return value.value;
  if (value.kind === "time") return value.valueUs;
  return undefined;
}

function arithmeticValue(
  operator: string,
  left: IrValue,
  right: IrValue,
  origin: SourceSpan,
): IrValue {
  const leftNumber = typedNumber(left);
  const rightNumber = typedNumber(right);
  if (leftNumber === undefined || rightNumber === undefined)
    fail("ARITHMETIC_TYPE", `Operator ${operator} requires numeric typed values.`, origin);
  const calculate = (a: number, b: number): number => {
    if (operator === "+") return a + b;
    if (operator === "-") return a - b;
    if (operator === "*") return a * b;
    if (operator === "/") return a / b;
    fail("ARITHMETIC_OPERATOR", `Unsupported arithmetic operator ${operator}.`, origin);
  };
  const output = calculate(leftNumber, rightNumber);
  if (!Number.isFinite(output))
    fail("ARITHMETIC_VALUE", "Arithmetic must produce a finite value.", origin);
  if (left.kind === "time" && (right.kind === "time" || right.kind === "number"))
    return { kind: "time", valueUs: irTimeUs(Math.round(output)) };
  if (left.kind === "length" && right.kind === "number") return { ...left, value: output };
  if (left.kind === "angle" && right.kind === "number") return { ...left, value: output };
  if (left.kind === "decibels" && right.kind === "number") return { ...left, value: output };
  if (left.kind === "percent" && right.kind === "number") return { ...left, value: output };
  return { kind: "number", value: output };
}

function evaluateExpression(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
): AttributeValue {
  const origin = nodeLocation(context.module, ast);
  if (ast.type === "Literal") {
    const literal = literalValue(ast);
    if (typeof literal === "string")
      return expressionValue({ kind: "string", value: literal }, origin);
    if (typeof literal === "number" && Number.isFinite(literal))
      return expressionValue({ kind: "number", value: literal }, origin);
    if (typeof literal === "boolean")
      return expressionValue({ kind: "boolean", value: literal }, origin);
    fail("VALUE_LITERAL", "Only string, number, and boolean literals are supported.", origin);
  }
  if (ast.type === "Identifier") {
    const name = identifierName(ast);
    const value = context.environment.get(name);
    if (value === undefined)
      fail(
        "UNKNOWN_IDENTIFIER",
        `Unknown identifier ${name}. Source is never executed as JavaScript.`,
        origin,
      );
    return value;
  }
  if (ast.type === "UnaryExpression" && ast.operator === "-") {
    const argument = evaluateExpression(node(ast.argument, "unary argument"), context, assets);
    return {
      value: { kind: "number", value: -numberArgument(argument.value, "Unary minus") },
      bindingKind: "computed",
      readSpan: origin,
    };
  }
  if (ast.type === "BinaryExpression") {
    const left = evaluateExpression(node(ast.left, "left operand"), context, assets);
    const right = evaluateExpression(node(ast.right, "right operand"), context, assets);
    return {
      value: arithmeticValue(String(ast.operator), left.value, right.value, origin),
      bindingKind: "computed",
      readSpan: origin,
    };
  }
  if (ast.type === "CallExpression") {
    const name = identifierName(node(ast.callee, "helper name"), "helper name");
    const args = nodes(ast.arguments, "helper arguments").map((argument) =>
      evaluateExpression(argument, context, assets),
    );
    const numeric = (): number => numberArgument(args[0]!.value, name);
    if (name === "seconds" && args.length === 1)
      return expressionValue(
        { kind: "time", valueUs: irTimeUs(Math.round(numeric() * 1_000_000)) },
        origin,
      );
    if (name === "milliseconds" && args.length === 1)
      return expressionValue(
        { kind: "time", valueUs: irTimeUs(Math.round(numeric() * 1_000)) },
        origin,
      );
    if (name === "microseconds" && args.length === 1)
      return expressionValue({ kind: "time", valueUs: irTimeUs(numeric()) }, origin);
    if (name === "px" && args.length === 1)
      return expressionValue({ kind: "length", unit: "px", value: numeric() }, origin);
    if (name === "percent" && args.length === 1)
      return expressionValue({ kind: "percent", value: numeric() }, origin);
    if (name === "deg" && args.length === 1)
      return expressionValue({ kind: "angle", unit: "deg", value: numeric() }, origin);
    if (name === "db" && args.length === 1)
      return expressionValue({ kind: "decibels", value: numeric() }, origin);
    if (name === "asset" && args.length === 1 && args[0]!.value.kind === "string") {
      const assetId = args[0]!.value.value;
      if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(assetId))
        fail("ASSET_ID", `Invalid stable asset id: ${assetId}.`, origin);
      if (!assets.has(assetId))
        fail("UNKNOWN_ASSET", `Asset ${assetId} is not declared in cinesim.toml.`, origin);
      return expressionValue({ kind: "resource", assetId }, origin);
    }
    if (name === "vec2" && args.length === 2)
      return expressionValue(
        {
          kind: "vector",
          values: [numberArgument(args[0]!.value, name), numberArgument(args[1]!.value, name)],
        },
        origin,
      );
    if (name === "rect" && args.length === 4)
      return expressionValue(
        {
          kind: "rectangle",
          values: args.map((argument) => numberArgument(argument.value, name)) as [
            number,
            number,
            number,
            number,
          ],
        },
        origin,
      );
    fail("UNKNOWN_HELPER", `Unsupported helper ${name}().`, origin);
  }
  fail(
    "UNSAFE_EXPRESSION",
    `Unsupported ${ast.type} expression. Source is parsed and lowered, never executed.`,
    origin,
  );
}

function coerceValue(value: IrValue, expected: IrValueKind, origin: SourceSpan): IrValue {
  if (value.kind === expected) return value;
  if (expected === "color" && value.kind === "string") {
    if (!COLOR.test(value.value)) fail("INVALID_COLOR", `Invalid color ${value.value}.`, origin);
    return { kind: "color", value: value.value.toLowerCase() };
  }
  if (expected === "angle" && value.kind === "number")
    return { kind: "angle", unit: "deg", value: value.value };
  fail("TYPE_MISMATCH", `Expected ${expected}, received ${value.kind}.`, origin);
}

function evaluateAttribute(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
  expected?: IrValueKind,
): AttributeValue {
  const attributeOrigin = nodeLocation(context.module, ast);
  const valueNode = optionalNode(ast.value);
  if (valueNode === undefined) {
    const value: IrValue = { kind: "boolean", value: true };
    return expressionValue(
      expected === undefined ? value : coerceValue(value, expected, attributeOrigin),
      attributeOrigin,
    );
  }
  let expressionNode: AstNode;
  let strategy: IrEditTarget["strategy"];
  if (valueNode.type === "JSXExpressionContainer") {
    expressionNode = node(valueNode.expression, "JSX attribute expression");
    strategy = "replace-expression";
  } else if (valueNode.type === "Literal") {
    expressionNode = valueNode;
    strategy = "replace-jsx-string";
  } else {
    fail(
      "ATTRIBUTE_VALUE",
      "Unsupported JSX attribute value.",
      nodeLocation(context.module, valueNode),
    );
  }
  const evaluated = evaluateExpression(expressionNode, context, assets);
  const value =
    expected === undefined
      ? evaluated.value
      : coerceValue(evaluated.value, expected, attributeOrigin);
  const direct = expressionNode.type !== "Identifier" && evaluated.bindingKind !== "computed";
  return {
    ...evaluated,
    value,
    readSpan: direct ? nodeLocation(context.module, expressionNode) : evaluated.readSpan,
    ...(evaluated.edit === undefined && !direct
      ? {}
      : {
          edit: {
            expected: expected ?? value.kind,
            source: direct ? nodeLocation(context.module, expressionNode) : evaluated.edit!.source,
            strategy: direct ? strategy : evaluated.edit!.strategy,
          },
        }),
  };
}

function stringAttribute(
  element: AstNode,
  name: string,
  context: CompileContext,
  assets: ReadonlySet<string>,
  required: boolean,
): AttributeValue | undefined {
  const attribute = attributes(element).find(
    (candidate) => candidate.type === "JSXAttribute" && jsxAttributeName(candidate) === name,
  );
  if (attribute === undefined) {
    if (required)
      fail(
        "MISSING_PROPERTY",
        `Missing required ${name} property.`,
        nodeLocation(context.module, element),
      );
    return undefined;
  }
  return evaluateAttribute(attribute, context, assets, "string");
}

function propertyValue(node: BoundNode, name: string): IrValue | undefined {
  return node.props[name]?.value;
}

function stringValue(node: BoundNode, name: string, fallback?: string): string {
  const value = propertyValue(node, name);
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "string" && value?.kind !== "color")
    throw new Error(`${node.kind}.${name} is not a string.`);
  return value.value;
}

function numberValue(node: BoundNode, name: string, fallback: number): number {
  const value = propertyValue(node, name);
  if (value === undefined) return fallback;
  if (
    value.kind === "number" ||
    value.kind === "length" ||
    value.kind === "angle" ||
    value.kind === "decibels" ||
    value.kind === "percent"
  )
    return value.value;
  throw new Error(`${node.kind}.${name} is not numeric.`);
}

function booleanValue(node: BoundNode, name: string, fallback: boolean): boolean {
  const value = propertyValue(node, name);
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") throw new Error(`${node.kind}.${name} is not boolean.`);
  return value.value;
}

function timeValue(node: BoundNode, name: string, fallback = 0): IrTimeUs {
  const value = propertyValue(node, name);
  if (value === undefined) return irTimeUs(fallback);
  if (value.kind !== "time") throw new Error(`${node.kind}.${name} is not time.`);
  return value.valueUs;
}

class Compilation {
  readonly diagnostics: IrDiagnostic[] = [];
  readonly modules = new Map<string, ModuleRecord>();
  readonly usedIds = new Set<string>();
  readonly bindings: EditMapBuilderNode[] = [];
  readonly #loading = new Set<string>();
  readonly #loadedGraphs = new Set<string>();
  readonly #assets: ReadonlySet<string>;
  #sourceBytes = 0;
  #expandedNodes = 0;

  constructor(
    private readonly host: CompilerHost,
    readonly config: CompilerConfig,
  ) {
    this.#assets = new Set(config.assetIds);
  }

  async loadModule(uri: string): Promise<ModuleRecord> {
    const existing = this.modules.get(uri);
    if (existing !== undefined) return existing;
    if (this.#loading.has(uri)) fail("IMPORT_CYCLE", `Import cycle detected at ${uri}.`);
    if (this.modules.size + this.#loading.size >= this.config.budgets.maxModules)
      fail("MODULE_BUDGET", `Module graph exceeds ${this.config.budgets.maxModules} modules.`);
    this.#loading.add(uri);
    try {
      const loaded = await this.host.read(uri);
      this.#sourceBytes += new TextEncoder().encode(loaded.source).byteLength;
      if (this.#sourceBytes > this.config.budgets.maxSourceBytes)
        fail("SOURCE_BUDGET", `Source graph exceeds ${this.config.budgets.maxSourceBytes} bytes.`);
      const parsed = parseModule(uri, loaded);
      this.modules.set(uri, parsed);
      return parsed;
    } finally {
      this.#loading.delete(uri);
    }
  }

  async loadModuleGraph(uri: string, ancestry: readonly string[] = []): Promise<ModuleRecord> {
    if (ancestry.includes(uri))
      fail("IMPORT_CYCLE", `Import cycle detected: ${[...ancestry, uri].join(" -> ")}.`);
    const module = await this.loadModule(uri);
    if (this.#loadedGraphs.has(uri)) return module;
    const nextAncestry = [...ancestry, uri];
    for (const binding of module.imports.values()) {
      if (!binding.source.startsWith("."))
        fail("BARE_IMPORT", `Only relative imports are supported: ${binding.source}.`);
      const imported = await this.loadModuleGraph(
        await this.host.resolve(binding.source, module.uri),
        nextAncestry,
      );
      if (!imported.components.has(binding.imported))
        fail("MISSING_EXPORT", `${binding.source} does not export ${binding.imported}.`);
    }
    this.#loadedGraphs.add(uri);
    return module;
  }

  reportUnknownProperty(name: string, kind: string, origin: SourceSpan): void {
    const diagnostic: IrDiagnostic = {
      severity: this.config.strict ? "error" : "warning",
      code: "UNKNOWN_PROPERTY",
      message: `${kind} does not define a ${name} property.`,
      source: origin,
    };
    if (this.config.strict) throw new CompilerError(diagnostic);
    if (this.diagnostics.length < this.config.budgets.maxDiagnostics)
      this.diagnostics.push(diagnostic);
  }

  claimId(id: string, origin: SourceSpan): void {
    if (this.usedIds.has(id)) fail("DUPLICATE_ID", `Duplicate semantic id ${id}.`, origin);
    this.usedIds.add(id);
  }

  structuralBinding(
    element: AstNode,
    context: CompileContext,
    id: string,
    nodeKind: string,
  ): IrStructuralBinding {
    const opening = openingElement(element);
    const closing = closingElement(element);
    const source = context.module.source;
    const lineStart = source.lastIndexOf("\n", element.start - 1) + 1;
    const indent = source.slice(lineStart, element.start).match(/^\s*/u)?.[0] ?? "";
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const beforeClose = opening.end - (opening.selfClosing === true ? 2 : 1);
    const closingOffset = closing === undefined ? beforeClose : closing.start;
    const closingLineStart = source.lastIndexOf("\n", closingOffset - 1) + 1;
    const childInsertionOffset =
      closing !== undefined && /^[ \t]*$/u.test(source.slice(closingLineStart, closingOffset))
        ? closingLineStart
        : closingOffset;
    return {
      nodeId: id,
      nodeKind,
      kind: context.componentStack.length === 0 ? "direct" : "generated",
      element: nodeLocation(context.module, element),
      openingElement: nodeLocation(context.module, opening),
      children: {
        uri: context.module.uri,
        revision: context.module.revision,
        start: nodeLocation(context.module, opening).end,
        end:
          closing === undefined
            ? nodeLocation(context.module, opening).end
            : nodeLocation(context.module, closing).start,
      },
      attributeInsertionOffset: beforeClose,
      insertionOffset: childInsertionOffset,
      style: { newline, indent },
      componentStack: context.componentStack,
      safeToRemove: context.componentStack.length === 0,
      safeToMove: context.componentStack.length === 0,
    };
  }

  async compileIntrinsic(
    element: AstNode,
    context: CompileContext,
    kind: string,
  ): Promise<BoundNode> {
    this.#expandedNodes += 1;
    if (this.#expandedNodes > this.config.budgets.maxExpansionNodes)
      fail(
        "NODE_BUDGET",
        `Expansion exceeds ${this.config.budgets.maxExpansionNodes} nodes.`,
        nodeLocation(context.module, element),
      );
    const schema = BUILTIN_REGISTRY[kind]!;
    const propertyValues = new Map<string, AttributeValue>();
    for (const attribute of attributes(element)) {
      if (attribute.type !== "JSXAttribute")
        fail(
          "SPREAD_ATTRIBUTE",
          "JSX spread attributes are not supported.",
          nodeLocation(context.module, attribute),
        );
      const name = jsxAttributeName(attribute);
      const propertySchema = schema.properties[name];
      if (propertySchema === undefined) {
        this.reportUnknownProperty(name, kind, nodeLocation(context.module, attribute));
        continue;
      }
      propertyValues.set(
        name,
        evaluateAttribute(attribute, context, this.#assets, propertySchema.type),
      );
    }
    for (const propertySchema of Object.values(schema.properties)) {
      if (propertyValues.has(propertySchema.name)) continue;
      if (propertySchema.required)
        fail(
          "MISSING_PROPERTY",
          `Missing required ${propertySchema.name} property on ${kind}.`,
          nodeLocation(context.module, element),
        );
      if (propertySchema.defaultValue !== undefined)
        propertyValues.set(propertySchema.name, {
          value: propertySchema.defaultValue,
          bindingKind: "default",
          readSpan: nodeLocation(context.module, element),
          writeProperty: propertySchema.name,
          insertion: {
            source: nodeLocation(context.module, openingElement(element)),
            beforeOffset:
              openingElement(element).end - (openingElement(element).selfClosing === true ? 2 : 1),
          },
        });
    }
    const idAttribute = propertyValues.get("id");
    if (idAttribute?.value.kind !== "string" || idAttribute.value.value.trim() === "")
      fail(
        "MISSING_ID",
        `${kind} requires a stable string id.`,
        nodeLocation(context.module, element),
      );
    const id = `${context.prefix}${idAttribute.value.value}`;
    this.claimId(id, idAttribute.readSpan);
    const props = Object.fromEntries([...propertyValues].filter(([name]) => name !== "id"));
    const children: BoundNode[] = [];
    const animations: BoundAnimation[] = [];
    for (const child of jsxChildren(element)) {
      if (child.type === "JSXText" && String(child.value).trim() === "") continue;
      if (
        child.type === "JSXExpressionContainer" &&
        node(child.expression, "child expression").type === "JSXEmptyExpression"
      )
        continue;
      if (child.type !== "JSXElement")
        fail(
          "CHILD_FORM",
          `Unsupported ${child.type} JSX child.`,
          nodeLocation(context.module, child),
        );
      if (jsxElementName(child) === "animate")
        animations.push(this.compileAnimation(child, context, props));
      else children.push(await this.compileElement(child, context));
    }
    const structural = this.structuralBinding(element, context, id, kind);
    const propertyBindings: IrPropertyBinding[] = [...propertyValues]
      .filter(([name]) => name !== "id")
      .map(([name, attribute]) => ({
        nodeId: id,
        property: name,
        ...(attribute.writeProperty === undefined
          ? {}
          : { writeProperty: attribute.writeProperty }),
        value: attribute.value,
        kind: attribute.bindingKind,
        readSpan: attribute.readSpan,
        ...(attributes(element).find(
          (candidate) => candidate.type === "JSXAttribute" && jsxAttributeName(candidate) === name,
        ) === undefined
          ? {}
          : {
              attributeSpan: nodeLocation(
                context.module,
                attributes(element).find(
                  (candidate) =>
                    candidate.type === "JSXAttribute" && jsxAttributeName(candidate) === name,
                )!,
              ),
            }),
        ...(attribute.edit === undefined ? {} : { writeSpan: attribute.edit.source }),
        ...(attribute.insertion === undefined ? {} : { insertion: attribute.insertion }),
        strategy: attribute.edit?.strategy ?? "insert-jsx-attribute",
        scopes:
          attribute.bindingKind === "default"
            ? ["instance", "definition"]
            : attribute.bindingKind === "computed"
              ? ["materialized"]
              : ["instance", "definition"],
        componentStack: context.componentStack,
      }));
    this.bindings.push({
      structural,
      properties: propertyBindings,
      animations: animations.map((animation) => ({
        property: animation.property,
        origin: animation.origin,
        keyframes: animation.keyframes.map((keyframe) => ({
          origin: keyframe.origin,
          at: keyframe.edits.at,
          value: keyframe.edits.value,
        })),
      })),
    });
    return {
      id,
      kind,
      origin: nodeLocation(context.module, element),
      opening: nodeLocation(context.module, openingElement(element)),
      childrenSpan: structural.children,
      insertionOffset: structural.insertionOffset,
      componentStack: context.componentStack,
      props,
      animations,
      children,
    };
  }

  compileAnimation(
    element: AstNode,
    context: CompileContext,
    parentProps: Record<string, AttributeValue>,
  ): BoundAnimation {
    const propertyAttribute = stringAttribute(element, "property", context, this.#assets, true)!;
    const property = propertyAttribute.value.kind === "string" ? propertyAttribute.value.value : "";
    const expected = parentProps[property]?.value.kind;
    if (expected === undefined)
      fail(
        "ANIMATION_TARGET",
        `Animation target ${property} must have an initial value.`,
        propertyAttribute.readSpan,
      );
    const keyframes: BoundKeyframe[] = [];
    for (const child of jsxChildren(element)) {
      if (child.type === "JSXText" && String(child.value).trim() === "") continue;
      if (child.type !== "JSXElement" || jsxElementName(child) !== "key")
        fail(
          "KEYFRAME_CHILD",
          "animate may only contain key elements.",
          nodeLocation(context.module, child),
        );
      const keyAttributes = new Map(
        attributes(child).map((attribute) => [jsxAttributeName(attribute), attribute]),
      );
      const atNode = keyAttributes.get("at");
      const valueNode = keyAttributes.get("value");
      if (atNode === undefined || valueNode === undefined)
        fail(
          "KEYFRAME_PROPERTY",
          "key requires at and value properties.",
          nodeLocation(context.module, child),
        );
      const at = evaluateAttribute(atNode, context, this.#assets, "time");
      const value = evaluateAttribute(valueNode, context, this.#assets, expected);
      if (at.value.kind !== "time" || at.edit === undefined || value.edit === undefined)
        fail(
          "KEYFRAME_EDIT",
          "Keyframes require directly editable values.",
          nodeLocation(context.module, child),
        );
      const easingNode = keyAttributes.get("easing");
      const easing =
        easingNode === undefined
          ? undefined
          : evaluateAttribute(easingNode, context, this.#assets, "string");
      keyframes.push({
        at: at.value.valueUs,
        value: value.value,
        easing: easing?.value.kind === "string" ? easing.value.value : "linear",
        origin: nodeLocation(context.module, child),
        edits: { at: at.edit, value: value.edit },
      });
    }
    if (keyframes.length < 2)
      fail(
        "KEYFRAME_COUNT",
        "animate requires at least two key elements.",
        nodeLocation(context.module, element),
      );
    keyframes.sort((left, right) => left.at - right.at);
    return { property, keyframes, origin: nodeLocation(context.module, element) };
  }

  async resolveComponent(
    name: string,
    module: ModuleRecord,
    origin: SourceSpan,
  ): Promise<{ module: ModuleRecord; declaration: AstNode; name: string }> {
    const local = module.components.get(name);
    if (local !== undefined) return { module, declaration: local, name };
    const binding = module.imports.get(name);
    if (binding === undefined)
      fail(
        "UNKNOWN_ELEMENT",
        `Unknown element ${name}. Built-ins are lowercase and components are capitalized.`,
        origin,
      );
    if (!binding.source.startsWith("."))
      fail("BARE_IMPORT", `Only relative imports are supported: ${binding.source}.`, origin);
    const importedModule = await this.loadModule(
      await this.host.resolve(binding.source, module.uri),
    );
    const declaration = importedModule.components.get(binding.imported);
    if (declaration === undefined)
      fail("MISSING_EXPORT", `${binding.source} does not export ${binding.imported}.`, origin);
    return { module: importedModule, declaration, name: binding.imported };
  }

  bindComponentProps(
    declaration: AstNode,
    invocation: AstNode,
    caller: CompileContext,
    componentModule: ModuleRecord,
  ): Map<string, AttributeValue> {
    const provided = new Map<string, AttributeValue>();
    for (const attribute of attributes(invocation)) {
      if (attribute.type !== "JSXAttribute")
        fail(
          "SPREAD_ATTRIBUTE",
          "JSX spread attributes are not supported.",
          nodeLocation(caller.module, attribute),
        );
      const evaluated = evaluateAttribute(attribute, caller, this.#assets);
      const name = jsxAttributeName(attribute);
      provided.set(name, {
        ...evaluated,
        bindingKind: "instance",
        writeProperty: evaluated.writeProperty ?? name,
      });
    }
    const parameters = nodes(declaration.params, "component parameters");
    if (parameters.length === 0) return new Map();
    if (parameters.length !== 1 || parameters[0]!.type !== "ObjectPattern")
      fail(
        "COMPONENT_PARAMETERS",
        "Components must take one destructured props object.",
        nodeLocation(componentModule, declaration),
      );
    const environment = new Map<string, AttributeValue>();
    const invocationOpening = openingElement(invocation);
    const insertion = {
      source: nodeLocation(caller.module, invocationOpening),
      beforeOffset: invocationOpening.end - (invocationOpening.selfClosing === true ? 2 : 1),
    };
    for (const item of nodes(parameters[0]!.properties, "component properties")) {
      if (item.type !== "Property")
        fail(
          "COMPONENT_REST",
          "Rest properties are not supported.",
          nodeLocation(componentModule, item),
        );
      const name = identifierName(node(item.key, "component property name"));
      const supplied = provided.get(name);
      if (supplied !== undefined) {
        environment.set(name, supplied);
        continue;
      }
      const valuePattern = node(item.value, "component property binding");
      if (valuePattern.type === "AssignmentPattern") {
        const evaluated = evaluateExpression(
          node(valuePattern.right, "default property value"),
          { module: componentModule, environment, prefix: "", componentStack: [] },
          this.#assets,
        );
        environment.set(name, {
          ...evaluated,
          bindingKind: "default",
          writeProperty: name,
          insertion,
        });
        continue;
      }
      fail(
        "MISSING_COMPONENT_PROP",
        `Missing required ${name} property.`,
        nodeLocation(caller.module, invocation),
      );
    }
    return environment;
  }

  componentReturn(declaration: AstNode, module: ModuleRecord): AstNode {
    const body = node(declaration.body, "component body");
    const returned = nodes(body.body, "component statements").find(
      (statement) => statement.type === "ReturnStatement",
    );
    const expression = returned === undefined ? undefined : optionalNode(returned.argument);
    if (expression?.type !== "JSXElement")
      fail(
        "COMPONENT_RETURN",
        "Component must return one JSX element.",
        nodeLocation(module, declaration),
      );
    return expression;
  }

  async compileComponent(
    element: AstNode,
    context: CompileContext,
    name: string,
  ): Promise<BoundNode> {
    const invocation = nodeLocation(context.module, element);
    const component = await this.resolveComponent(name, context.module, invocation);
    if (
      context.componentStack.some(
        (frame) => frame.name === component.name && frame.definition.uri === component.module.uri,
      )
    )
      fail("RECURSIVE_COMPONENT", `Recursive component ${name} is not supported.`, invocation);
    if (context.componentStack.length >= this.config.budgets.maxComponentDepth)
      fail(
        "COMPONENT_DEPTH",
        `Component expansion exceeds ${this.config.budgets.maxComponentDepth} levels.`,
        invocation,
      );
    const idAttribute = stringAttribute(element, "id", context, this.#assets, true)!;
    const instanceId = idAttribute.value.kind === "string" ? idAttribute.value.value : "";
    const definition = nodeLocation(component.module, component.declaration);
    const environment = this.bindComponentProps(
      component.declaration,
      element,
      context,
      component.module,
    );
    const frame: ComponentFrame = { name: component.name, definition, invocation, instanceId };
    const result = await this.compileElement(
      this.componentReturn(component.declaration, component.module),
      {
        module: component.module,
        environment,
        prefix: `${context.prefix}${instanceId}/`,
        componentStack: [...context.componentStack, frame],
      },
    );
    if (TEMPORAL_BUILTINS.has(result.kind))
      fail(
        "COMPONENT_TEMPORAL",
        `Component ${name} cannot generate ${result.kind} structure.`,
        invocation,
      );
    return result;
  }

  async compileElement(element: AstNode, context: CompileContext): Promise<BoundNode> {
    const name = jsxElementName(element);
    if (name === "animate" || name === "key")
      fail(
        "SPECIAL_ELEMENT",
        `${name} cannot appear outside animation.`,
        nodeLocation(context.module, element),
      );
    if (name[0] === name[0]?.toLowerCase()) {
      if (BUILTIN_REGISTRY[name] === undefined)
        fail(
          "UNKNOWN_BUILTIN",
          `Unknown lowercase built-in ${name}.`,
          nodeLocation(context.module, element),
        );
      return this.compileIntrinsic(element, context, name);
    }
    return this.compileComponent(element, context, name);
  }

  moduleSummaries(): CompilerModuleSummary[] {
    return [...this.modules.values()]
      .sort((left, right) => left.uri.localeCompare(right.uri))
      .map((module) => ({
        uri: module.uri,
        revision: module.revision,
        imports: [...module.imports.values()],
        components: [...module.components.keys()].sort(),
        compositions: [...module.compositionExports.keys()].sort(),
        ...(module.defaultExport === undefined
          ? {}
          : {
              defaultExport:
                module.defaultExport.type === "Identifier"
                  ? identifierName(module.defaultExport)
                  : "<inline>",
            }),
      }));
  }
}

function runtimeAnimation(animation: BoundAnimation): IrAnimation {
  return {
    property: animation.property,
    keyframes: animation.keyframes.map((keyframe) => ({
      at: keyframe.at,
      value: keyframe.value,
      easing: keyframe.easing,
    })),
  };
}

function lowerEffect(node: BoundNode): IrEffect {
  return {
    id: node.id,
    kind: node.kind as IrEffect["kind"],
    enabled: booleanValue(node, "enabled", true),
    props: Object.fromEntries(
      Object.entries(node.props)
        .filter(([name]) => name !== "enabled")
        .map(([name, property]) => [name, property.value]),
    ),
    children: node.children.filter((child) => !EFFECT_BUILTINS.has(child.kind)).map(lowerSceneNode),
  };
}

function lowerSceneNode(node: BoundNode): IrSceneNode {
  return {
    id: node.id,
    kind: node.kind,
    props: Object.fromEntries(
      Object.entries(node.props).map(([name, property]) => [name, property.value]),
    ),
    animations: node.animations.map(runtimeAnimation),
    effects: node.children.filter((child) => EFFECT_BUILTINS.has(child.kind)).map(lowerEffect),
    children: node.children.filter((child) => !EFFECT_BUILTINS.has(child.kind)).map(lowerSceneNode),
  };
}

function lowerClip(node: BoundNode, trackId: string): IrClip {
  const asset = propertyValue(node, "asset");
  const media = propertyValue(node, "media");
  const linked = propertyValue(node, "linked");
  const composition = propertyValue(node, "composition");
  const visualChildren = node.children.filter((child) => !EFFECT_BUILTINS.has(child.kind));
  const content =
    visualChildren.length === 0
      ? undefined
      : visualChildren.length === 1
        ? lowerSceneNode(visualChildren[0]!)
        : {
            id: `${node.id}/content`,
            kind: "group",
            props: {},
            animations: [],
            effects: [],
            children: visualChildren.map(lowerSceneNode),
          };
  const scale = numberValue(node, "scale", 1);
  const crop = propertyValue(node, "crop");
  return {
    id: node.id,
    trackId,
    ...(propertyValue(node, "name") === undefined ? {} : { name: stringValue(node, "name") }),
    ...(asset?.kind === "resource" ? { assetId: asset.assetId } : {}),
    ...(composition?.kind === "string" ? { compositionId: composition.value } : {}),
    ...(media?.kind === "string" && MEDIA_KINDS.has(media.value)
      ? { mediaKind: media.value as "video" | "audio" }
      : {}),
    ...(linked?.kind === "string" ? { linkedClipId: linked.value } : {}),
    timelineStartUs: timeValue(node, "start"),
    sourceStartUs: timeValue(node, "in"),
    durationUs: timeValue(node, "duration"),
    playbackRate: numberValue(node, "playbackRate", 1),
    enabled: booleanValue(node, "enabled", true),
    reverse: booleanValue(node, "reverse", false),
    freeze: booleanValue(node, "freeze", false),
    loop: booleanValue(node, "loop", false),
    fades: { inUs: timeValue(node, "fadeIn"), outUs: timeValue(node, "fadeOut") },
    transform: {
      x: numberValue(node, "x", 0),
      y: numberValue(node, "y", 0),
      ...(propertyValue(node, "width") === undefined
        ? {}
        : { width: numberValue(node, "width", 0) }),
      ...(propertyValue(node, "height") === undefined
        ? {}
        : { height: numberValue(node, "height", 0) }),
      anchorX: numberValue(node, "anchorX", 50),
      anchorY: numberValue(node, "anchorY", 50),
      scaleX: numberValue(node, "scaleX", scale),
      scaleY: numberValue(node, "scaleY", scale),
      rotation: numberValue(node, "rotation", 0),
      opacity: numberValue(node, "opacity", 1),
      zIndex: numberValue(node, "z", 0),
      fit: stringValue(node, "fit", "contain") as "contain" | "cover" | "fill",
      ...(crop?.kind === "rectangle" ? { crop: crop.values } : {}),
      cornerRadius: numberValue(node, "cornerRadius", 0),
      blendMode: stringValue(node, "blendMode", "normal"),
    },
    audio: {
      gainDb: numberValue(node, "gain", 0),
      pan: numberValue(node, "pan", 0),
      muted: booleanValue(node, "muted", false),
    },
    ...(content === undefined ? {} : { content }),
    effects: node.children.filter((child) => EFFECT_BUILTINS.has(child.kind)).map(lowerEffect),
  };
}

function lowerTrack(node: BoundNode): IrTrack {
  const kind = stringValue(node, "kind");
  if (!TRACK_KINDS.has(kind)) fail("TRACK_KIND", `Invalid track kind ${kind}.`, node.origin);
  return {
    id: node.id,
    kind: kind as IrTrack["kind"],
    name: stringValue(node, "name"),
    muted: booleanValue(node, "muted", false),
    locked: booleanValue(node, "locked", false),
    clips: node.children
      .filter((child) => child.kind === "clip")
      .map((clip) => lowerClip(clip, node.id)),
    effects: node.children.filter((child) => EFFECT_BUILTINS.has(child.kind)).map(lowerEffect),
  };
}

function lowerComposition(node: BoundNode): IrComposition {
  const timeline = node.children.find((child) => child.kind === "timeline");
  if (!timeline)
    fail("TIMELINE_REQUIRED", `Composition ${node.id} requires one timeline.`, node.origin);
  const extra = node.children.filter((child) => child.kind !== "timeline");
  if (extra.length > 0)
    fail("COMPOSITION_CHILD", "Composition may only contain a timeline.", extra[0]!.origin);
  const markers = timeline.children
    .filter((child) => child.kind === "marker")
    .map((marker) => ({
      id: marker.id,
      atUs: timeValue(marker, "at"),
      name: stringValue(marker, "name"),
      ...(propertyValue(marker, "color")?.kind === "color"
        ? { color: stringValue(marker, "color") }
        : {}),
    }));
  const transitions = timeline.children
    .filter((child) => child.kind === "transition")
    .map((transition) => {
      const kind = stringValue(transition, "kind");
      if (!TRANSITIONS.has(kind))
        fail("TRANSITION_KIND", `Invalid transition kind ${kind}.`, transition.origin);
      return {
        id: transition.id,
        fromClipId: stringValue(transition, "from"),
        toClipId: stringValue(transition, "to"),
        kind: kind as "cut",
        durationUs: timeValue(transition, "duration"),
        props: {},
      };
    });
  const fps =
    propertyValue(node, "fps") === undefined
      ? numberValue(node, "frameRate", 0)
      : numberValue(node, "fps", 0);
  return {
    id: node.id,
    name: stringValue(node, "name", node.id),
    width: numberValue(node, "width", 0),
    height: numberValue(node, "height", 0),
    frameRate: fps,
    background: stringValue(node, "background", "#09090b"),
    timeline: {
      id: timeline.id,
      tracks: timeline.children.filter((child) => child.kind === "track").map(lowerTrack),
      markers,
      transitions,
    },
  };
}

function visitBound(nodesToVisit: readonly BoundNode[]): CompilerExplanation[] {
  const result: CompilerExplanation[] = [];
  const visit = (current: BoundNode): void => {
    result.push({
      nodeId: current.id,
      kind: current.kind,
      definedAt: displayLocation(current.origin),
      expandedThrough: current.componentStack.map(
        (frame) => `${frame.name} invoked at ${displayLocation(frame.invocation)}`,
      ),
    });
    current.children.forEach(visit);
  };
  nodesToVisit.forEach(visit);
  return result;
}

function compositionElements(entry: ModuleRecord): AstNode[] {
  const exported = [...entry.compositionExports.values()];
  if (exported.length > 0) return exported;
  if (entry.defaultExport?.type === "JSXElement") return [entry.defaultExport];
  if (entry.defaultExport?.type === "Identifier") {
    const value = entry.variables.get(identifierName(entry.defaultExport));
    if (value?.type === "JSXElement") return [value];
  }
  fail(
    "DEFAULT_EXPORT",
    `${entry.uri} must export at least one composition and default-export one statically.`,
  );
}

export async function compileVideo(
  entryUri: string,
  config: CompilerConfig,
  host: CompilerHost,
): Promise<CompileResult> {
  const compilation = new Compilation(host, config);
  const entry = await compilation.loadModuleGraph(entryUri);
  const roots: BoundNode[] = [];
  for (const element of compositionElements(entry)) {
    const root = await compilation.compileElement(element, {
      module: entry,
      environment: new Map(),
      prefix: "",
      componentStack: [],
    });
    if (root.kind !== "composition")
      fail(
        "ROOT_ELEMENT",
        "Exported composition values must be composition elements.",
        root.origin,
      );
    roots.push(root);
  }
  const compositions = roots.map(lowerComposition);
  const referenced = new Set<string>();
  const collectSceneAssets = (node: IrSceneNode): void => {
    for (const value of Object.values(node.props))
      if (value.kind === "resource") referenced.add(value.assetId);
    for (const animation of node.animations)
      for (const keyframe of animation.keyframes)
        if (keyframe.value.kind === "resource") referenced.add(keyframe.value.assetId);
    for (const effect of node.effects) {
      for (const value of Object.values(effect.props))
        if (value.kind === "resource") referenced.add(value.assetId);
      effect.children.forEach(collectSceneAssets);
    }
    node.children.forEach(collectSceneAssets);
  };
  for (const composition of compositions) {
    for (const track of composition.timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.assetId !== undefined) referenced.add(clip.assetId);
        if (clip.content) collectSceneAssets(clip.content);
      }
    }
  }
  const referencedAssetIds = [...referenced].sort((left, right) => left.localeCompare(right));
  const ir: IrProgram = {
    version: 2,
    languageVersion: config.languageVersion,
    projectId: config.projectId,
    activeCompositionId: config.activeCompositionId,
    compositions,
    referencedAssetIds,
  };
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
    explanations: visitBound(roots),
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
