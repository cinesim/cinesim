import type {
  ComponentFrame,
  EditMapBuilderNode,
  IrDiagnostic,
  IrPropertyBinding,
  IrStructuralBinding,
  IrValueKind,
  SourceSpan,
} from "@cinesim/ir";
import { node, nodes, optionalNode, type AstNode } from "./ast";
import { CompilerError, fail } from "./compiler-errors";
import type {
  AttributeValue,
  BoundAnimation,
  BoundKeyframe,
  BoundNode,
  CompileContext,
  ModuleRecord,
} from "./compiler-model";
import { evaluateAttribute, evaluateExpression, stringAttribute } from "./expressions";
import {
  attributes,
  closingElement,
  identifierName,
  jsxAttributeName,
  jsxChildren,
  jsxElementName,
  nodeLocation,
  openingElement,
} from "./jsx-syntax";
import { parseModule } from "./module-parser";
import { BUILTIN_REGISTRY, TEMPORAL_BUILTINS, type PropertySchema } from "./registry";
import type { CompilerConfig, CompilerHost, CompilerModuleSummary } from "./types";

interface CompiledChildren {
  children: BoundNode[];
  animations: BoundAnimation[];
}

export class Compilation {
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
    if (this.modules.size + this.#loading.size >= this.config.budgets.maxModules) {
      fail("MODULE_BUDGET", `Module graph exceeds ${this.config.budgets.maxModules} modules.`);
    }
    this.#loading.add(uri);
    try {
      const loaded = await this.host.read(uri);
      this.#sourceBytes += new TextEncoder().encode(loaded.source).byteLength;
      if (this.#sourceBytes > this.config.budgets.maxSourceBytes) {
        fail("SOURCE_BUDGET", `Source graph exceeds ${this.config.budgets.maxSourceBytes} bytes.`);
      }
      const parsed = parseModule(uri, loaded);
      this.modules.set(uri, parsed);
      return parsed;
    } finally {
      this.#loading.delete(uri);
    }
  }

  async loadModuleGraph(uri: string, ancestry: readonly string[] = []): Promise<ModuleRecord> {
    if (ancestry.includes(uri)) {
      fail("IMPORT_CYCLE", `Import cycle detected: ${[...ancestry, uri].join(" -> ")}.`);
    }
    const module = await this.loadModule(uri);
    if (this.#loadedGraphs.has(uri)) return module;
    const nextAncestry = [...ancestry, uri];
    for (const binding of module.imports.values()) {
      if (!binding.source.startsWith(".")) {
        fail("BARE_IMPORT", `Only relative imports are supported: ${binding.source}.`);
      }
      const imported = await this.loadModuleGraph(
        await this.host.resolve(binding.source, module.uri),
        nextAncestry,
      );
      if (!imported.components.has(binding.imported)) {
        fail("MISSING_EXPORT", `${binding.source} does not export ${binding.imported}.`);
      }
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
    if (this.diagnostics.length < this.config.budgets.maxDiagnostics) {
      this.diagnostics.push(diagnostic);
    }
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

  readProperties(
    element: AstNode,
    context: CompileContext,
    kind: string,
  ): Map<string, AttributeValue> {
    const schema = BUILTIN_REGISTRY[kind]!;
    const values = new Map<string, AttributeValue>();
    for (const attribute of attributes(element)) {
      if (attribute.type !== "JSXAttribute") {
        fail(
          "SPREAD_ATTRIBUTE",
          "JSX spread attributes are not supported.",
          nodeLocation(context.module, attribute),
        );
      }
      const name = jsxAttributeName(attribute);
      const property = schema.properties[name];
      if (property === undefined) {
        this.reportUnknownProperty(name, kind, nodeLocation(context.module, attribute));
      } else {
        values.set(name, evaluateAttribute(attribute, context, this.#assets, property.type));
      }
    }
    return values;
  }

  defaultProperty(
    element: AstNode,
    context: CompileContext,
    property: PropertySchema,
  ): AttributeValue {
    const opening = openingElement(element);
    return {
      value: property.defaultValue!,
      bindingKind: "default",
      readSpan: nodeLocation(context.module, element),
      writeProperty: property.name,
      insertion: {
        source: nodeLocation(context.module, opening),
        beforeOffset: opening.end - (opening.selfClosing === true ? 2 : 1),
      },
    };
  }

  addDefaultProperties(
    element: AstNode,
    context: CompileContext,
    kind: string,
    values: Map<string, AttributeValue>,
  ): void {
    for (const property of Object.values(BUILTIN_REGISTRY[kind]!.properties)) {
      if (values.has(property.name)) continue;
      if (property.required) {
        fail(
          "MISSING_PROPERTY",
          `Missing required ${property.name} property on ${kind}.`,
          nodeLocation(context.module, element),
        );
      }
      if (property.defaultValue !== undefined) {
        values.set(property.name, this.defaultProperty(element, context, property));
      }
    }
  }

  semanticId(
    element: AstNode,
    context: CompileContext,
    kind: string,
    values: ReadonlyMap<string, AttributeValue>,
  ): string {
    const attribute = values.get("id");
    if (attribute?.value.kind !== "string" || attribute.value.value.trim() === "") {
      fail(
        "MISSING_ID",
        `${kind} requires a stable string id.`,
        nodeLocation(context.module, element),
      );
    }
    const id = `${context.prefix}${attribute.value.value}`;
    this.claimId(id, attribute.readSpan);
    return id;
  }

  async compileChildren(
    element: AstNode,
    context: CompileContext,
    props: Record<string, AttributeValue>,
  ): Promise<CompiledChildren> {
    const result: CompiledChildren = { children: [], animations: [] };
    for (const child of jsxChildren(element)) {
      if (child.type === "JSXText" && String(child.value).trim() === "") continue;
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
        result.animations.push(this.compileAnimation(child, context, props));
      } else {
        result.children.push(await this.compileElement(child, context));
      }
    }
    return result;
  }

  propertyBindings(
    element: AstNode,
    context: CompileContext,
    id: string,
    values: ReadonlyMap<string, AttributeValue>,
  ): IrPropertyBinding[] {
    const attributeSpans = new Map(
      attributes(element)
        .filter((attribute) => attribute.type === "JSXAttribute")
        .map((attribute) => [jsxAttributeName(attribute), nodeLocation(context.module, attribute)]),
    );
    return [...values]
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
        ...(attributeSpans.has(name) ? { attributeSpan: attributeSpans.get(name)! } : {}),
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
  }

  recordBinding(
    structural: IrStructuralBinding,
    properties: IrPropertyBinding[],
    animations: readonly BoundAnimation[],
  ): void {
    this.bindings.push({
      structural,
      properties,
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
  }

  async compileIntrinsic(
    element: AstNode,
    context: CompileContext,
    kind: string,
  ): Promise<BoundNode> {
    this.#expandedNodes += 1;
    if (this.#expandedNodes > this.config.budgets.maxExpansionNodes) {
      fail(
        "NODE_BUDGET",
        `Expansion exceeds ${this.config.budgets.maxExpansionNodes} nodes.`,
        nodeLocation(context.module, element),
      );
    }
    const values = this.readProperties(element, context, kind);
    this.addDefaultProperties(element, context, kind, values);
    const id = this.semanticId(element, context, kind, values);
    const props = Object.fromEntries([...values].filter(([name]) => name !== "id"));
    const { children, animations } = await this.compileChildren(element, context, props);
    const structural = this.structuralBinding(element, context, id, kind);
    this.recordBinding(structural, this.propertyBindings(element, context, id, values), animations);
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

  compileKeyframe(child: AstNode, context: CompileContext, expected: IrValueKind): BoundKeyframe {
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
    const at = evaluateAttribute(atNode, context, this.#assets, "time");
    const value = evaluateAttribute(valueNode, context, this.#assets, expected);
    if (at.value.kind !== "time" || at.edit === undefined || value.edit === undefined) {
      fail(
        "KEYFRAME_EDIT",
        "Keyframes require directly editable values.",
        nodeLocation(context.module, child),
      );
    }
    const easingNode = keyAttributes.get("easing");
    const easing =
      easingNode === undefined
        ? undefined
        : evaluateAttribute(easingNode, context, this.#assets, "string");
    return {
      at: at.value.valueUs,
      value: value.value,
      easing: easing?.value.kind === "string" ? easing.value.value : "linear",
      origin: nodeLocation(context.module, child),
      edits: { at: at.edit, value: value.edit },
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
    if (expected === undefined) {
      fail(
        "ANIMATION_TARGET",
        `Animation target ${property} must have an initial value.`,
        propertyAttribute.readSpan,
      );
    }
    const keyframes = jsxChildren(element)
      .filter((child) => child.type !== "JSXText" || String(child.value).trim() !== "")
      .map((child) => this.compileKeyframe(child, context, expected));
    if (keyframes.length < 2) {
      fail(
        "KEYFRAME_COUNT",
        "animate requires at least two key elements.",
        nodeLocation(context.module, element),
      );
    }
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
    if (binding === undefined) {
      fail(
        "UNKNOWN_ELEMENT",
        `Unknown element ${name}. Built-ins are lowercase and components are capitalized.`,
        origin,
      );
    }
    if (!binding.source.startsWith(".")) {
      fail("BARE_IMPORT", `Only relative imports are supported: ${binding.source}.`, origin);
    }
    const importedModule = await this.loadModule(
      await this.host.resolve(binding.source, module.uri),
    );
    const declaration = importedModule.components.get(binding.imported);
    if (declaration === undefined) {
      fail("MISSING_EXPORT", `${binding.source} does not export ${binding.imported}.`, origin);
    }
    return { module: importedModule, declaration, name: binding.imported };
  }

  providedComponentProps(invocation: AstNode, caller: CompileContext): Map<string, AttributeValue> {
    const provided = new Map<string, AttributeValue>();
    for (const attribute of attributes(invocation)) {
      if (attribute.type !== "JSXAttribute") {
        fail(
          "SPREAD_ATTRIBUTE",
          "JSX spread attributes are not supported.",
          nodeLocation(caller.module, attribute),
        );
      }
      const evaluated = evaluateAttribute(attribute, caller, this.#assets);
      const name = jsxAttributeName(attribute);
      provided.set(name, {
        ...evaluated,
        bindingKind: "instance",
        writeProperty: evaluated.writeProperty ?? name,
      });
    }
    return provided;
  }

  bindComponentProps(
    declaration: AstNode,
    invocation: AstNode,
    caller: CompileContext,
    componentModule: ModuleRecord,
  ): Map<string, AttributeValue> {
    const provided = this.providedComponentProps(invocation, caller);
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
    const invocationOpening = openingElement(invocation);
    const insertion = {
      source: nodeLocation(caller.module, invocationOpening),
      beforeOffset: invocationOpening.end - (invocationOpening.selfClosing === true ? 2 : 1),
    };
    for (const item of nodes(parameters[0]!.properties, "component properties")) {
      if (item.type !== "Property") {
        fail(
          "COMPONENT_REST",
          "Rest properties are not supported.",
          nodeLocation(componentModule, item),
        );
      }
      const name = identifierName(node(item.key, "component property name"));
      const supplied = provided.get(name);
      if (supplied !== undefined) {
        environment.set(name, supplied);
        continue;
      }
      const valuePattern = node(item.value, "component property binding");
      if (valuePattern.type !== "AssignmentPattern") {
        fail(
          "MISSING_COMPONENT_PROP",
          `Missing required ${name} property.`,
          nodeLocation(caller.module, invocation),
        );
      }
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
    }
    return environment;
  }

  componentReturn(declaration: AstNode, module: ModuleRecord): AstNode {
    const body = node(declaration.body, "component body");
    const returned = nodes(body.body, "component statements").find(
      (statement) => statement.type === "ReturnStatement",
    );
    const expression = returned === undefined ? undefined : optionalNode(returned.argument);
    if (expression?.type !== "JSXElement") {
      fail(
        "COMPONENT_RETURN",
        "Component must return one JSX element.",
        nodeLocation(module, declaration),
      );
    }
    return expression;
  }

  async compileComponent(
    element: AstNode,
    context: CompileContext,
    name: string,
  ): Promise<BoundNode> {
    const invocation = nodeLocation(context.module, element);
    const component = await this.resolveComponent(name, context.module, invocation);
    const recursive = context.componentStack.some(
      (frame) => frame.name === component.name && frame.definition.uri === component.module.uri,
    );
    if (recursive)
      fail("RECURSIVE_COMPONENT", `Recursive component ${name} is not supported.`, invocation);
    if (context.componentStack.length >= this.config.budgets.maxComponentDepth) {
      fail(
        "COMPONENT_DEPTH",
        `Component expansion exceeds ${this.config.budgets.maxComponentDepth} levels.`,
        invocation,
      );
    }
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
    if (TEMPORAL_BUILTINS.has(result.kind)) {
      fail(
        "COMPONENT_TEMPORAL",
        `Component ${name} cannot generate ${result.kind} structure.`,
        invocation,
      );
    }
    return result;
  }

  async compileElement(element: AstNode, context: CompileContext): Promise<BoundNode> {
    const name = jsxElementName(element);
    if (name === "animate" || name === "key") {
      fail(
        "SPECIAL_ELEMENT",
        `${name} cannot appear outside animation.`,
        nodeLocation(context.module, element),
      );
    }
    if (name[0] === name[0]?.toLowerCase()) {
      if (BUILTIN_REGISTRY[name] === undefined) {
        fail(
          "UNKNOWN_BUILTIN",
          `Unknown lowercase built-in ${name}.`,
          nodeLocation(context.module, element),
        );
      }
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
