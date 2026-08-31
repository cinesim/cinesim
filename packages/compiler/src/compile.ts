import {
  createIrSourceMap,
  type ComponentFrame,
  type IrAnimation,
  type IrDiagnostic,
  type IrDocument,
  type IrEditTarget,
  type IrKeyframe,
  type IrNode,
  type IrProperty,
  type IrValue,
  type IrValueKind,
  type SourceSpan,
} from "@cinesim/ir";
import { node, nodes, optionalNode, parseJavaScript, stringField, type AstNode } from "./ast";
import type {
  CompileResult,
  CompilerConfig,
  CompilerExplanation,
  CompilerHost,
  CompilerModuleSummary,
  CompilerSource,
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
  defaultExport?: AstNode;
}

interface AttributeValue {
  value: IrValue;
  edit: IrEditTarget;
}

interface CompileContext {
  module: ModuleRecord;
  environment: Map<string, AttributeValue>;
  prefix: string;
  componentStack: ComponentFrame[];
}

type PropTypes = Record<string, IrValueKind>;

const sharedProps: PropTypes = {
  id: "string",
  opacity: "number",
  rotation: "number",
  scale: "number",
  x: "length",
  y: "length",
  z: "number",
};

const builtins: Record<string, PropTypes> = {
  composition: {
    id: "string",
    width: "number",
    height: "number",
    frameRate: "number",
    duration: "time",
    background: "color",
  },
  group: { ...sharedProps, blendMode: "string" },
  grid: {
    ...sharedProps,
    columns: "number",
    rows: "number",
    gap: "length",
    width: "length",
    height: "length",
  },
  video: {
    ...sharedProps,
    source: "resource",
    width: "length",
    height: "length",
    fit: "string",
    radius: "length",
    volume: "number",
  },
  rect: {
    ...sharedProps,
    width: "length",
    height: "length",
    fill: "color",
    radius: "length",
    blur: "length",
  },
  text: {
    ...sharedProps,
    text: "string",
    color: "color",
    fontFamily: "string",
    fontSize: "length",
    fontWeight: "number",
    maxWidth: "length",
    align: "string",
  },
  colorgrade: {
    ...sharedProps,
    exposure: "number",
    contrast: "number",
    saturation: "number",
    temperature: "number",
    tint: "number",
  },
};

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
  if (ast.type !== "Identifier" && ast.type !== "JSXIdentifier") {
    throw new Error(`Expected ${description}.`);
  }
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
  };

  for (const statement of nodes(program.body, "module statements")) {
    if (statement.type === "ImportDeclaration") {
      const sourceNode = node(statement.source, "import source");
      const source = literalValue(sourceNode);
      if (typeof source !== "string") fail("IMPORT_SOURCE", "Import sources must be strings.");
      for (const specifier of nodes(statement.specifiers, "import specifiers")) {
        if (specifier.type !== "ImportSpecifier") {
          fail(
            "IMPORT_FORM",
            "Only named component imports are supported in video source files.",
            nodeLocation(module, specifier),
          );
        }
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

    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? optionalNode(statement.declaration)
        : statement.type === "FunctionDeclaration"
          ? statement
          : undefined;
    if (declaration?.type === "FunctionDeclaration") {
      const name = identifierName(node(declaration.id, "component function name"));
      module.components.set(name, declaration);
    }
  }

  return module;
}

function numberArgument(value: IrValue, helper: string): number {
  if (value.kind !== "number" || !Number.isFinite(value.value)) {
    throw new Error(`${helper} expects a finite number.`);
  }
  return value.value;
}

function expressionValue(value: IrValue, source: SourceSpan): AttributeValue {
  return {
    value,
    edit: { expected: value.kind, source, strategy: "replace-expression" },
  };
}

function evaluateExpression(ast: AstNode, context: CompileContext): AttributeValue {
  const origin = nodeLocation(context.module, ast);
  if (ast.type === "Literal") {
    const value = literalValue(ast);
    if (typeof value === "string") return expressionValue({ kind: "string", value }, origin);
    if (typeof value === "number" && Number.isFinite(value)) {
      return expressionValue({ kind: "number", value }, origin);
    }
    if (typeof value === "boolean") return expressionValue({ kind: "boolean", value }, origin);
    fail("VALUE_LITERAL", "Only string, number, and boolean literals are supported.", origin);
  }

  if (ast.type === "Identifier") {
    const name = identifierName(ast);
    const value = context.environment.get(name);
    if (value === undefined) {
      fail(
        "UNKNOWN_IDENTIFIER",
        `Unknown identifier ${name}. Video source is not executed as JavaScript.`,
        origin,
      );
    }
    return value;
  }

  if (ast.type === "UnaryExpression" && ast.operator === "-") {
    const argument = evaluateExpression(node(ast.argument, "unary argument"), context);
    return expressionValue(
      { kind: "number", value: -numberArgument(argument.value, "Unary minus") },
      origin,
    );
  }

  if (ast.type === "CallExpression") {
    const callee = node(ast.callee, "helper name");
    const name = identifierName(callee, "helper name");
    const args = nodes(ast.arguments, "helper arguments").map((argument) =>
      evaluateExpression(argument, context),
    );
    if (name === "seconds" && args.length === 1) {
      return expressionValue(
        {
          kind: "time",
          valueUs: Math.round(numberArgument(args[0]!.value, name) * 1_000_000),
        },
        origin,
      );
    }
    if (name === "milliseconds" && args.length === 1) {
      return expressionValue(
        { kind: "time", valueUs: Math.round(numberArgument(args[0]!.value, name) * 1_000) },
        origin,
      );
    }
    if (name === "px" && args.length === 1) {
      return expressionValue(
        { kind: "length", unit: "px", value: numberArgument(args[0]!.value, name) },
        origin,
      );
    }
    if (name === "asset" && args.length === 1 && args[0]!.value.kind === "string") {
      return expressionValue({ kind: "resource", uri: args[0]!.value.value }, origin);
    }
    if (name === "vec2" && args.length === 2) {
      return expressionValue(
        { kind: "vector", values: args.map((argument) => argument.value) },
        origin,
      );
    }
    fail(
      "UNKNOWN_HELPER",
      `Unsupported helper ${name}(). Supported helpers: seconds, milliseconds, px, asset, vec2.`,
      origin,
    );
  }

  fail(
    "UNSAFE_EXPRESSION",
    `Unsupported ${ast.type} expression. Video source is parsed and lowered, never executed.`,
    origin,
  );
}

function coerceValue(value: IrValue, expected: IrValueKind, origin: SourceSpan): IrValue {
  if (value.kind === expected) return value;
  if (expected === "color" && value.kind === "string") return { kind: "color", value: value.value };
  if (expected === "resource" && value.kind === "string")
    return { kind: "resource", uri: value.value };
  fail("TYPE_MISMATCH", `Expected ${expected}, received ${value.kind}.`, origin);
}

function jsxAttributeName(ast: AstNode): string {
  return identifierName(node(ast.name, "JSX attribute name"), "JSX attribute name");
}

function evaluateAttribute(
  ast: AstNode,
  context: CompileContext,
  expected?: IrValueKind,
): AttributeValue {
  const attributeOrigin = nodeLocation(context.module, ast);
  const valueNode = optionalNode(ast.value);
  if (valueNode === undefined) {
    const value: IrValue = { kind: "boolean", value: true };
    return {
      value: expected === undefined ? value : coerceValue(value, expected, attributeOrigin),
      edit: {
        expected: expected ?? value.kind,
        source: attributeOrigin,
        strategy: "replace-expression",
      },
    };
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

  const evaluated = evaluateExpression(expressionNode, context);
  const value =
    expected === undefined
      ? evaluated.value
      : coerceValue(evaluated.value, expected, attributeOrigin);
  const editSource =
    expressionNode.type === "Identifier"
      ? evaluated.edit.source
      : nodeLocation(context.module, expressionNode);
  const editStrategy = expressionNode.type === "Identifier" ? evaluated.edit.strategy : strategy;
  return {
    value,
    edit: {
      expected: expected ?? value.kind,
      source: editSource,
      strategy: editStrategy,
    },
  };
}

function openingElement(ast: AstNode): AstNode {
  return node(ast.openingElement, "JSX opening element");
}

function jsxElementName(ast: AstNode): string {
  const opening = openingElement(ast);
  const name = node(opening.name, "JSX element name");
  if (name.type !== "JSXIdentifier") {
    throw new Error("Namespaced and member JSX element names are not supported.");
  }
  return identifierName(name, "JSX element name");
}

function attributes(ast: AstNode): AstNode[] {
  return nodes(openingElement(ast).attributes, "JSX attributes");
}

function jsxChildren(ast: AstNode): AstNode[] {
  return nodes(ast.children, "JSX children");
}

function stringAttribute(
  element: AstNode,
  name: string,
  context: CompileContext,
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
  return evaluateAttribute(attribute, context, "string");
}

class Compilation {
  readonly diagnostics: IrDiagnostic[] = [];
  readonly modules = new Map<string, ModuleRecord>();
  readonly usedIds = new Set<string>();

  constructor(
    private readonly host: CompilerHost,
    private readonly config: CompilerConfig,
  ) {}

  async loadModule(uri: string): Promise<ModuleRecord> {
    const existing = this.modules.get(uri);
    if (existing !== undefined) return existing;
    const parsed = parseModule(uri, await this.host.read(uri));
    this.modules.set(uri, parsed);
    return parsed;
  }

  reportUnknownProperty(name: string, kind: string, origin: SourceSpan): void {
    const diagnostic: IrDiagnostic = {
      severity: this.config.strict ? "error" : "warning",
      code: "UNKNOWN_PROPERTY",
      message: `${kind} does not define a ${name} property.`,
      source: origin,
    };
    if (this.config.strict) throw new CompilerError(diagnostic);
    this.diagnostics.push(diagnostic);
  }

  claimId(id: string, origin: SourceSpan): void {
    if (this.usedIds.has(id)) fail("DUPLICATE_ID", `Duplicate node id ${id}.`, origin);
    this.usedIds.add(id);
  }

  async compileIntrinsic(element: AstNode, context: CompileContext, kind: string): Promise<IrNode> {
    const schema = builtins[kind]!;
    const propertyValues = new Map<string, AttributeValue>();
    for (const attribute of attributes(element)) {
      if (attribute.type !== "JSXAttribute") {
        fail(
          "SPREAD_ATTRIBUTE",
          "JSX spread attributes are not supported.",
          nodeLocation(context.module, attribute),
        );
      }
      const name = jsxAttributeName(attribute);
      const expected = schema[name];
      if (expected === undefined) {
        this.reportUnknownProperty(name, kind, nodeLocation(context.module, attribute));
        continue;
      }
      propertyValues.set(name, evaluateAttribute(attribute, context, expected));
    }

    const idAttribute = propertyValues.get("id");
    if (idAttribute?.value.kind !== "string" || idAttribute.value.value.trim() === "") {
      fail(
        "MISSING_ID",
        `${kind} requires a stable string id.`,
        nodeLocation(context.module, element),
      );
    }
    const id = `${context.prefix}${idAttribute.value.value}`;
    this.claimId(id, idAttribute.edit.source);

    const props: Record<string, IrProperty> = {};
    for (const [name, value] of propertyValues) {
      if (name !== "id") props[name] = value;
    }

    const children: IrNode[] = [];
    const animations: IrAnimation[] = [];
    for (const child of jsxChildren(element)) {
      if (child.type === "JSXText") {
        if (String(child.value).trim() !== "") {
          fail(
            "TEXT_CHILD",
            "Use the text element's text property for visible text.",
            nodeLocation(context.module, child),
          );
        }
        continue;
      }
      if (
        child.type === "JSXExpressionContainer" &&
        node(child.expression, "child expression").type === "JSXEmptyExpression"
      ) {
        continue;
      }
      if (child.type !== "JSXElement") {
        fail(
          "CHILD_FORM",
          `Unsupported ${child.type} JSX child.`,
          nodeLocation(context.module, child),
        );
      }
      if (jsxElementName(child) === "animate") {
        animations.push(this.compileAnimation(child, context, props));
      } else {
        children.push(await this.compileElement(child, context));
      }
    }

    return {
      id,
      kind,
      origin: nodeLocation(context.module, element),
      componentStack: context.componentStack,
      props,
      animations,
      children,
    };
  }

  compileAnimation(
    element: AstNode,
    context: CompileContext,
    parentProps: Record<string, IrProperty>,
  ): IrAnimation {
    const propertyAttribute = stringAttribute(element, "property", context, true)!;
    const property = propertyAttribute.value.kind === "string" ? propertyAttribute.value.value : "";
    const expected = parentProps[property]?.value.kind;
    if (expected === undefined) {
      fail(
        "ANIMATION_TARGET",
        `Animation target ${property} must also have an initial value on its parent element.`,
        propertyAttribute.edit.source,
      );
    }

    const keyframes: IrKeyframe[] = [];
    for (const child of jsxChildren(element)) {
      if (child.type === "JSXText" && String(child.value).trim() === "") continue;
      if (child.type !== "JSXElement" || jsxElementName(child) !== "key") {
        fail(
          "KEYFRAME_CHILD",
          "animate may only contain key elements.",
          nodeLocation(context.module, child),
        );
      }
      const keyAttributes = new Map(
        attributes(child).map((attribute) => [jsxAttributeName(attribute), attribute]),
      );
      const atNode = keyAttributes.get("at");
      const valueNode = keyAttributes.get("value");
      if (atNode === undefined || valueNode === undefined) {
        fail(
          "KEYFRAME_PROPERTY",
          "key requires at and value properties.",
          nodeLocation(context.module, child),
        );
      }
      const at = evaluateAttribute(atNode, context, "time");
      const value = evaluateAttribute(valueNode, context, expected);
      const easingNode = keyAttributes.get("easing");
      const easing =
        easingNode === undefined ? undefined : evaluateAttribute(easingNode, context, "string");
      if (at.value.kind !== "time") throw new Error("Internal keyframe time mismatch.");
      keyframes.push({
        at: at.value,
        value: value.value,
        easing: easing?.value.kind === "string" ? easing.value.value : "linear",
        origin: nodeLocation(context.module, child),
        edits: { at: at.edit, value: value.edit },
      });
    }
    if (keyframes.length < 2) {
      fail(
        "KEYFRAME_COUNT",
        "animate requires at least two key elements.",
        nodeLocation(context.module, element),
      );
    }
    keyframes.sort((left, right) => left.at.valueUs - right.at.valueUs);
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
    if (binding === undefined) fail("UNKNOWN_ELEMENT", `Unknown element ${name}.`, origin);
    if (!binding.source.startsWith(".")) {
      fail(
        "BARE_IMPORT",
        `Only relative video component imports are supported: ${binding.source}.`,
        origin,
      );
    }
    const importedModule = await this.loadModule(
      await this.host.resolve(binding.source, module.uri),
    );
    const declaration = importedModule.components.get(binding.imported);
    if (declaration === undefined) {
      fail(
        "MISSING_EXPORT",
        `${binding.source} does not export a ${binding.imported} component.`,
        origin,
      );
    }
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
      if (attribute.type !== "JSXAttribute") {
        fail(
          "SPREAD_ATTRIBUTE",
          "JSX spread attributes are not supported.",
          nodeLocation(caller.module, attribute),
        );
      }
      provided.set(jsxAttributeName(attribute), evaluateAttribute(attribute, caller));
    }

    const parameters = nodes(declaration.params, "component parameters");
    if (parameters.length === 0) return new Map();
    if (parameters.length !== 1 || parameters[0]!.type !== "ObjectPattern") {
      fail(
        "COMPONENT_PARAMETERS",
        "Components must take one destructured props object.",
        nodeLocation(componentModule, declaration),
      );
    }

    const environment = new Map<string, AttributeValue>();
    for (const property of nodes(parameters[0]!.properties, "component properties")) {
      if (property.type !== "Property") {
        fail(
          "COMPONENT_REST",
          "Rest properties are not supported.",
          nodeLocation(componentModule, property),
        );
      }
      const name = identifierName(node(property.key, "component property name"));
      const valuePattern = node(property.value, "component property binding");
      const supplied = provided.get(name);
      if (supplied !== undefined) {
        environment.set(name, supplied);
        continue;
      }
      if (valuePattern.type === "AssignmentPattern") {
        const defaultContext: CompileContext = {
          module: componentModule,
          environment,
          prefix: "",
          componentStack: [],
        };
        environment.set(
          name,
          evaluateExpression(node(valuePattern.right, "default property value"), defaultContext),
        );
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
    if (returned === undefined) {
      fail(
        "COMPONENT_RETURN",
        "Component must return one JSX element.",
        nodeLocation(module, declaration),
      );
    }
    const expression = node(returned.argument, "component return value");
    if (expression.type !== "JSXElement") {
      fail(
        "COMPONENT_RETURN",
        "Component must return one JSX element.",
        nodeLocation(module, expression),
      );
    }
    return expression;
  }

  async compileComponent(element: AstNode, context: CompileContext, name: string): Promise<IrNode> {
    const invocation = nodeLocation(context.module, element);
    const component = await this.resolveComponent(name, context.module, invocation);
    if (
      context.componentStack.some(
        (frame) => frame.name === component.name && frame.definition.uri === component.module.uri,
      )
    ) {
      fail("RECURSIVE_COMPONENT", `Recursive component ${name} is not supported.`, invocation);
    }
    if (context.componentStack.length >= 32) {
      fail("COMPONENT_DEPTH", "Component expansion exceeded 32 levels.", invocation);
    }

    const id = stringAttribute(element, "id", context, true)!;
    const instanceId = id.value.kind === "string" ? id.value.value : "";
    const definition = nodeLocation(component.module, component.declaration);
    const environment = this.bindComponentProps(
      component.declaration,
      element,
      context,
      component.module,
    );
    const frame: ComponentFrame = { name: component.name, definition, invocation };
    return this.compileElement(this.componentReturn(component.declaration, component.module), {
      module: component.module,
      environment,
      prefix: `${context.prefix}${instanceId}/`,
      componentStack: [...context.componentStack, frame],
    });
  }

  async compileElement(element: AstNode, context: CompileContext): Promise<IrNode> {
    const name = jsxElementName(element);
    if (name === "animate" || name === "key") {
      fail(
        "SPECIAL_ELEMENT",
        `${name} cannot appear outside its animation context.`,
        nodeLocation(context.module, element),
      );
    }
    return builtins[name] === undefined
      ? this.compileComponent(element, context, name)
      : this.compileIntrinsic(element, context, name);
  }

  moduleSummaries(): CompilerModuleSummary[] {
    return [...this.modules.values()]
      .sort((left, right) => left.uri.localeCompare(right.uri))
      .map((module) => ({
        uri: module.uri,
        revision: module.revision,
        imports: [...module.imports.values()],
        components: [...module.components.keys()].sort((left, right) => left.localeCompare(right)),
        hasDefaultExport: module.defaultExport !== undefined,
      }));
  }
}

function explanations(root: IrNode): CompilerExplanation[] {
  const result: CompilerExplanation[] = [];
  function visit(current: IrNode): void {
    result.push({
      nodeId: current.id,
      kind: current.kind,
      definedAt: displayLocation(current.origin),
      expandedThrough: current.componentStack.map(
        (frame) => `${frame.name} invoked at ${displayLocation(frame.invocation)}`,
      ),
    });
    for (const child of current.children) visit(child);
  }
  visit(root);
  return result;
}

export async function compileVideo(
  entryUri: string,
  config: CompilerConfig,
  host: CompilerHost,
): Promise<CompileResult> {
  const compilation = new Compilation(host, config);
  const entry = await compilation.loadModule(entryUri);
  if (entry.defaultExport === undefined) {
    fail("DEFAULT_EXPORT", `${entryUri} must default-export one JSX scene.`);
  }
  if (entry.defaultExport.type !== "JSXElement") {
    fail(
      "DEFAULT_EXPORT",
      "The default export must be one JSX scene.",
      nodeLocation(entry, entry.defaultExport),
    );
  }

  const root = await compilation.compileElement(entry.defaultExport, {
    module: entry,
    environment: new Map(),
    prefix: "",
    componentStack: [],
  });
  if (root.kind !== "composition") {
    fail("ROOT_ELEMENT", "The root JSX element must be composition.", root.origin);
  }

  const sources = [...compilation.modules.values()]
    .map((module) => ({ uri: module.uri, revision: module.revision }))
    .sort((left, right) => left.uri.localeCompare(right.uri));
  const ir: IrDocument = { version: 1, entry: entryUri, sources, root };
  return {
    ir,
    sourceMap: createIrSourceMap(ir),
    diagnostics: compilation.diagnostics,
    modules: compilation.moduleSummaries(),
    explanations: explanations(root),
  };
}
