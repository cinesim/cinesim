import type {
  IrEditMap,
  IrEditTarget,
  IrNodeTemplate,
  IrPropertyBinding,
  IrStructuralBinding,
  IrValue,
  SemanticPatch,
  SourceSpan,
} from "@cinesim/ir";
import { getBuiltinSchema } from "./registry";
import { jsxAttribute, printNodeTemplate, replacementText } from "./source-printer";

export { printIrExpression, printNodeTemplate } from "./source-printer";

export interface SourceRewrite {
  source: string;
  revision: string;
  target: IrEditTarget;
  value: IrValue;
}

export interface SourceReplacement {
  uri: string;
  expectedRevision: string;
  start: number;
  end: number;
  text: string;
}

export interface SourceEditPlan {
  replacements: SourceReplacement[];
  touchedUris: string[];
}

interface PlanningContext {
  sourceMap: IrEditMap;
  sources: Readonly<Record<string, string>>;
  movedNodeIds: ReadonlySet<string>;
  deferredMoveProperties: ReadonlyMap<string, readonly SourceReplacement[]>;
}

export function rewriteSourceValue(input: SourceRewrite): string {
  if (input.revision !== input.target.source.revision) {
    throw new Error("Source changed after compilation; refusing to apply a stale edit.");
  }
  if (input.value.kind !== input.target.expected) {
    throw new Error(`Expected a ${input.target.expected} value, received ${input.value.kind}.`);
  }
  const replacement = replacementText(input.target, input.value);
  return `${input.source.slice(0, input.target.source.start.offset)}${replacement}${input.source.slice(input.target.source.end.offset)}`;
}

function replacement(
  span: SourceSpan,
  start: number,
  end: number,
  text: string,
): SourceReplacement {
  return { uri: span.uri, expectedRevision: span.revision, start, end, text };
}

function lineRemoval(source: string, span: SourceSpan): { start: number; end: number } {
  const lineStart = source.lastIndexOf("\n", span.start.offset - 1) + 1;
  const leading = source.slice(lineStart, span.start.offset);
  const nextNewline = source.indexOf("\n", span.end.offset);
  if (/^[ \t]*$/u.test(leading) && nextNewline >= 0) {
    return { start: lineStart, end: nextNewline + 1 };
  }
  return { start: span.start.offset, end: span.end.offset };
}

function compositionDeclaration(
  source: string,
  target: IrStructuralBinding,
): { start: number; end: number; identifier: string } | null {
  if (target.nodeKind !== "composition") return null;
  const elementLineStart = source.lastIndexOf("\n", target.element.start.offset - 1) + 1;
  const declarationLineStart = source.lastIndexOf("\n", elementLineStart - 2) + 1;
  const declaration = source.slice(declarationLineStart, elementLineStart);
  const match = /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\r?\n$/u.exec(declaration);
  if (!match) return null;
  const suffix = source.slice(target.element.end.offset);
  const closing = /^\s*\r?\n\s*\);\s*(?:\r?\n|$)/u.exec(suffix);
  if (!closing) return null;
  return {
    start: declarationLineStart,
    end: target.element.end.offset + closing[0].length,
    identifier: match[1]!,
  };
}

function applyNestedReplacements(
  source: string,
  start: number,
  end: number,
  replacements: readonly SourceReplacement[],
): string {
  let result = source.slice(start, end);
  for (const item of [...replacements].sort((left, right) => right.start - left.start)) {
    if (item.start < start || item.end > end) {
      throw new Error("A moved-node property edit escaped its source element.");
    }
    result = `${result.slice(0, item.start - start)}${item.text}${result.slice(item.end - start)}`;
  }
  return result;
}

function programInsertion(
  sourceMap: IrEditMap,
  sources: Readonly<Record<string, string>>,
  template: IrNodeTemplate | string,
): SourceReplacement {
  const source = sources[sourceMap.entry];
  const revision = sourceMap.sources.find((item) => item.uri === sourceMap.entry)?.revision;
  if (source === undefined || revision === undefined)
    throw new Error("Entry source is unavailable.");
  const printed = typeof template === "string" ? template : printNodeTemplate(template);
  return {
    uri: sourceMap.entry,
    expectedRevision: revision,
    start: source.length,
    end: source.length,
    text: `\n${printed}\n`,
  };
}

function childSource(template: IrNodeTemplate | string, parent: IrStructuralBinding): string {
  const indent = `${parent.style.indent}  `;
  if (typeof template !== "string") return printNodeTemplate(template, indent);
  return template
    .split(/\r?\n/u)
    .map((line) => `${indent}${line}`)
    .join(parent.style.newline);
}

function anchoredInsertion(
  anchor: string,
  printed: string,
  parent: IrStructuralBinding,
  sourceMap: IrEditMap,
): SourceReplacement {
  const before = anchor.startsWith("before:");
  const id = anchor.replace(/^(?:before|after):/u, "");
  const sibling = sourceMap.nodes[id]?.structural;
  if (!sibling || sibling.element.uri !== parent.element.uri) {
    throw new Error(`Invalid insertion anchor ${anchor}.`);
  }
  const offset = before ? sibling.element.start.offset : sibling.element.end.offset;
  const text = before ? `${printed}${parent.style.newline}` : `${parent.style.newline}${printed}`;
  return replacement(parent.element, offset, offset, text);
}

function insertionReplacement(
  parentId: string,
  sourceMap: IrEditMap,
  sources: Readonly<Record<string, string>>,
  template: IrNodeTemplate | string,
  anchor?: string,
): SourceReplacement {
  if (parentId === "$program") return programInsertion(sourceMap, sources, template);
  const parent = sourceMap.nodes[parentId]?.structural;
  if (!parent) throw new Error(`No editable parent binding for ${parentId}.`);
  const source = sources[parent.element.uri];
  if (source === undefined) throw new Error(`Missing source snapshot ${parent.element.uri}.`);
  const printed = childSource(template, parent);
  if (anchor !== undefined) return anchoredInsertion(anchor, printed, parent, sourceMap);
  const selfClosing =
    source.slice(parent.attributeInsertionOffset, parent.openingElement.end.offset) === "/>";
  if (selfClosing) {
    const text = `>${parent.style.newline}${printed}${parent.style.newline}${parent.style.indent}</${parent.nodeKind}>`;
    return replacement(
      parent.element,
      parent.attributeInsertionOffset,
      parent.openingElement.end.offset,
      text,
    );
  }
  return replacement(
    parent.element,
    parent.insertionOffset,
    parent.insertionOffset,
    `${printed}${parent.style.newline}${parent.style.indent}`,
  );
}

function boundPropertyReplacement(
  patch: Extract<SemanticPatch, { type: "property.set" }>,
  binding: IrPropertyBinding,
): SourceReplacement {
  if (!binding.scopes.includes(patch.scope)) {
    throw new Error(`${patch.nodeId}.${patch.property} does not allow ${patch.scope} edits.`);
  }
  if (binding.kind === "computed" && patch.scope !== "materialized") {
    throw new Error(
      `Computed property ${patch.nodeId}.${patch.property} requires materialization.`,
    );
  }
  if (binding.kind === "default" && patch.scope === "instance") {
    if (!binding.insertion) {
      throw new Error(`No instance override insertion for ${patch.nodeId}.${patch.property}.`);
    }
    return replacement(
      binding.insertion.source,
      binding.insertion.beforeOffset,
      binding.insertion.beforeOffset,
      ` ${jsxAttribute(binding.writeProperty ?? patch.property, patch.value)}`,
    );
  }
  if (!binding.writeSpan) {
    throw new Error(`Property ${patch.nodeId}.${patch.property} has no writable span.`);
  }
  if (binding.value.kind !== patch.value.kind) {
    throw new Error(`Expected ${binding.value.kind}, received ${patch.value.kind}.`);
  }
  const target: IrEditTarget = {
    expected: binding.value.kind,
    source: binding.writeSpan,
    strategy: binding.strategy,
  };
  return replacement(
    binding.writeSpan,
    binding.writeSpan.start.offset,
    binding.writeSpan.end.offset,
    replacementText(target, patch.value),
  );
}

function propertyReplacement(
  patch: Extract<SemanticPatch, { type: "property.set" }>,
  sourceMap: IrEditMap,
): SourceReplacement {
  const node = sourceMap.nodes[patch.nodeId];
  if (!node) throw new Error(`No editable source binding for ${patch.nodeId}.`);
  const binding = node.properties[patch.property];
  if (binding !== undefined) return boundPropertyReplacement(patch, binding);
  const property = getBuiltinSchema(node.structural.nodeKind)?.properties[patch.property];
  if (!property) throw new Error(`${node.structural.nodeKind} does not define ${patch.property}.`);
  if (property.type !== patch.value.kind) {
    throw new Error(`Expected ${property.type}, received ${patch.value.kind}.`);
  }
  return replacement(
    node.structural.openingElement,
    node.structural.attributeInsertionOffset,
    node.structural.attributeInsertionOffset,
    ` ${jsxAttribute(patch.property, patch.value)}`,
  );
}

function deferredMoveProperties(
  patches: readonly SemanticPatch[],
  movedNodeIds: ReadonlySet<string>,
  sourceMap: IrEditMap,
): Map<string, SourceReplacement[]> {
  const result = new Map<string, SourceReplacement[]>();
  for (const patch of patches) {
    if (patch.type !== "property.set" || !movedNodeIds.has(patch.nodeId)) continue;
    const replacements = result.get(patch.nodeId) ?? [];
    replacements.push(propertyReplacement(patch, sourceMap));
    result.set(patch.nodeId, replacements);
  }
  return result;
}

function removePropertyReplacement(
  patch: Extract<SemanticPatch, { type: "property.remove" }>,
  context: PlanningContext,
): SourceReplacement {
  const binding = context.sourceMap.nodes[patch.nodeId]?.properties[patch.property];
  if (!binding?.attributeSpan) {
    throw new Error(`Property ${patch.nodeId}.${patch.property} has no removable attribute.`);
  }
  let start = binding.attributeSpan.start.offset;
  if (context.sources[binding.attributeSpan.uri]?.[start - 1] === " ") start -= 1;
  return replacement(binding.attributeSpan, start, binding.attributeSpan.end.offset, "");
}

function replacementDefaultExport(
  source: string,
  removedNodeId: string,
  declaration: NonNullable<ReturnType<typeof compositionDeclaration>>,
  context: PlanningContext,
): SourceReplacement | undefined {
  const defaultExport = new RegExp(`export\\s+default\\s+${declaration.identifier}\\s*;`, "u").exec(
    source,
  );
  if (!defaultExport) return undefined;
  const replacementIdentifier = Object.entries(context.sourceMap.nodes)
    .filter(([id, node]) => id !== removedNodeId && node.structural.nodeKind === "composition")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, node]) => compositionDeclaration(source, node.structural)?.identifier)
    .find((identifier): identifier is string => identifier !== undefined);
  if (!replacementIdentifier) {
    throw new Error("Cannot remove the default composition without a replacement.");
  }
  const identifierOffset = defaultExport.index + defaultExport[0].indexOf(declaration.identifier);
  return replacement(
    context.sourceMap.nodes[removedNodeId]!.structural.element,
    identifierOffset,
    identifierOffset + declaration.identifier.length,
    replacementIdentifier,
  );
}

function removeNodeReplacements(
  patch: Extract<SemanticPatch, { type: "node.remove" }>,
  target: IrStructuralBinding,
  source: string,
  range: { start: number; end: number },
  context: PlanningContext,
): SourceReplacement[] {
  const declaration = compositionDeclaration(source, target);
  const removal = replacement(
    target.element,
    declaration?.start ?? range.start,
    declaration?.end ?? range.end,
    "",
  );
  if (!declaration) return [removal];
  const defaultExport = replacementDefaultExport(source, patch.nodeId, declaration, context);
  return defaultExport ? [removal, defaultExport] : [removal];
}

function structuralReplacements(
  patch: Extract<SemanticPatch, { type: "node.remove" | "node.replace" | "node.move" }>,
  context: PlanningContext,
): SourceReplacement[] {
  const target = context.sourceMap.nodes[patch.nodeId]?.structural;
  if (!target || !target.safeToRemove) {
    throw new Error(`Node ${patch.nodeId} is generated or has no safe structural edit lens.`);
  }
  const source = context.sources[target.element.uri];
  if (source === undefined) throw new Error(`Missing source snapshot ${target.element.uri}.`);
  const range = lineRemoval(source, target.element);
  if (patch.type === "node.remove") {
    return removeNodeReplacements(patch, target, source, range, context);
  }
  if (patch.type === "node.replace") {
    const printed = patch.nodes
      .map((template) => printNodeTemplate(template, target.style.indent))
      .join(target.style.newline);
    return [
      replacement(
        target.element,
        target.element.start.offset,
        target.element.end.offset,
        printed.trimStart(),
      ),
    ];
  }
  if (!target.safeToMove) throw new Error(`Node ${patch.nodeId} cannot be moved safely.`);
  const raw = applyNestedReplacements(
    source,
    target.element.start.offset,
    target.element.end.offset,
    context.deferredMoveProperties.get(patch.nodeId) ?? [],
  ).trim();
  return [
    replacement(target.element, range.start, range.end, ""),
    insertionReplacement(patch.parentId, context.sourceMap, context.sources, raw, patch.anchor),
  ];
}

function replacementsForPatch(patch: SemanticPatch, context: PlanningContext): SourceReplacement[] {
  switch (patch.type) {
    case "property.set":
      return context.movedNodeIds.has(patch.nodeId)
        ? []
        : [propertyReplacement(patch, context.sourceMap)];
    case "property.remove":
      return [removePropertyReplacement(patch, context)];
    case "node.insert":
      return [
        insertionReplacement(
          patch.parentId,
          context.sourceMap,
          context.sources,
          patch.node,
          patch.anchor,
        ),
      ];
    default:
      return structuralReplacements(patch, context);
  }
}

function orderAndValidate(replacements: readonly SourceReplacement[]): SourceReplacement[] {
  const ordered = [...replacements].sort(
    (left, right) =>
      left.uri.localeCompare(right.uri) || right.start - left.start || right.end - left.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const overlaps =
      previous.uri === current.uri &&
      current.end > previous.start &&
      current.start !== current.end &&
      previous.start !== previous.end;
    if (overlaps) throw new Error(`Overlapping source edits in ${current.uri}.`);
  }
  return ordered;
}

export function planSemanticSourceEdits(
  patches: readonly SemanticPatch[],
  sourceMap: IrEditMap,
  sources: Readonly<Record<string, string>>,
): SourceEditPlan {
  const movedNodeIds = new Set(
    patches.flatMap((patch) => (patch.type === "node.move" ? [patch.nodeId] : [])),
  );
  const context: PlanningContext = {
    sourceMap,
    sources,
    movedNodeIds,
    deferredMoveProperties: deferredMoveProperties(patches, movedNodeIds, sourceMap),
  };
  const replacements = orderAndValidate(
    patches.flatMap((patch) => replacementsForPatch(patch, context)),
  );
  return {
    replacements,
    touchedUris: [...new Set(replacements.map((item) => item.uri))].sort(),
  };
}

export function applySourceEditPlan(
  sources: Readonly<Record<string, string>>,
  plan: SourceEditPlan,
  revisions?: Readonly<Record<string, string>>,
): Record<string, string> {
  const next = { ...sources };
  for (const uri of plan.touchedUris) {
    let source = sources[uri];
    if (source === undefined) throw new Error(`Missing source snapshot ${uri}.`);
    const edits = plan.replacements
      .filter((item) => item.uri === uri)
      .sort((left, right) => right.start - left.start || right.end - left.end);
    const revision = revisions?.[uri] ?? edits[0]?.expectedRevision;
    if (revision !== edits[0]?.expectedRevision) {
      throw new Error(`Source changed after compilation: ${uri}.`);
    }
    for (const edit of edits) {
      if (edit.expectedRevision !== revision) {
        throw new Error(`Inconsistent expected revisions for ${uri}.`);
      }
      source = `${source.slice(0, edit.start)}${edit.text}${source.slice(edit.end)}`;
    }
    next[uri] = source;
  }
  return next;
}
