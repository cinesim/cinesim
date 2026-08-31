import type {
  IrClip,
  IrComposition,
  IrEditMap,
  IrEditTarget,
  IrEffect,
  IrNodeTemplate,
  IrSceneNode,
  IrTrack,
  IrValue,
  SemanticPatch,
  SourceSpan,
} from "@cinesim/ir";
import { getBuiltinSchema } from "./registry";

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

function rawValue(value: IrValue): string | number | boolean {
  switch (value.kind) {
    case "boolean":
    case "number":
    case "string":
    case "color":
    case "angle":
    case "decibels":
    case "percent":
      return value.value;
    case "length":
      return `${value.value}px`;
    case "resource":
      return value.assetId;
    case "time":
      return `${value.valueUs}us`;
    case "vector":
    case "rectangle":
      return value.values.join(", ");
  }
}

export function printIrExpression(value: IrValue): string {
  switch (value.kind) {
    case "boolean":
    case "number":
      return String(value.value);
    case "string":
    case "color":
      return JSON.stringify(value.value);
    case "angle":
      return `deg(${value.value})`;
    case "decibels":
      return `db(${value.value})`;
    case "percent":
      return `percent(${value.value})`;
    case "length":
      return `px(${value.value})`;
    case "resource":
      return `asset(${JSON.stringify(value.assetId)})`;
    case "time":
      return `microseconds(${value.valueUs})`;
    case "vector":
      return `vec2(${value.values.join(", ")})`;
    case "rectangle":
      return `rect(${value.values.join(", ")})`;
  }
}

function replacementText(target: IrEditTarget, value: IrValue): string {
  return target.strategy === "replace-jsx-string"
    ? JSON.stringify(rawValue(value))
    : printIrExpression(value);
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

function jsxAttribute(name: string, value: IrValue): string {
  return value.kind === "string" || value.kind === "color"
    ? `${name}=${JSON.stringify(value.value)}`
    : `${name}={${printIrExpression(value)}}`;
}

function sceneSource(node: IrSceneNode, indent: string): string {
  const properties = Object.entries(node.props).map(
    ([name, value]) =>
      `${name}=${value.kind === "string" || value.kind === "color" ? JSON.stringify(value.value) : `{${printIrExpression(value)}}`}`,
  );
  const opening = `<${node.kind} id=${JSON.stringify(node.id)}${properties.length === 0 ? "" : ` ${properties.join(" ")}`}`;
  const children = [
    ...node.children.map((child) => sceneSource(child, `${indent}  `)),
    ...node.effects.map((effect) => effectSource(effect, `${indent}  `)),
  ];
  if (children.length === 0 && node.animations.length === 0) return `${indent}${opening} />`;
  const animations = node.animations.map((animation) =>
    [
      `${indent}  <animate property=${JSON.stringify(animation.property)}>`,
      ...animation.keyframes.map(
        (keyframe) =>
          `${indent}    <key at={microseconds(${keyframe.at})} value={${printIrExpression(keyframe.value)}} easing=${JSON.stringify(keyframe.easing)} />`,
      ),
      `${indent}  </animate>`,
    ].join("\n"),
  );
  return [`${indent}${opening}>`, ...animations, ...children, `${indent}</${node.kind}>`].join(
    "\n",
  );
}

function effectSource(effect: IrEffect, indent: string): string {
  const node: IrSceneNode = {
    id: effect.id,
    kind: effect.kind,
    props: { enabled: { kind: "boolean", value: effect.enabled }, ...effect.props },
    animations: [],
    effects: [],
    children: effect.children,
  };
  return sceneSource(node, indent);
}

function clipSource(clip: IrClip, indent: string): string {
  const attributes = [
    `id=${JSON.stringify(clip.id)}`,
    ...(clip.name === undefined ? [] : [`name=${JSON.stringify(clip.name)}`]),
    ...(clip.assetId === undefined ? [] : [`asset={asset(${JSON.stringify(clip.assetId)})}`]),
    ...(clip.compositionId === undefined
      ? []
      : [`composition=${JSON.stringify(clip.compositionId)}`]),
    ...(clip.mediaKind === undefined ? [] : [`media=${JSON.stringify(clip.mediaKind)}`]),
    ...(clip.linkedClipId === undefined ? [] : [`linked=${JSON.stringify(clip.linkedClipId)}`]),
    `start={microseconds(${clip.timelineStartUs})}`,
    `in={microseconds(${clip.sourceStartUs})}`,
    `duration={microseconds(${clip.durationUs})}`,
    `playbackRate={${clip.playbackRate}}`,
    `enabled={${clip.enabled}}`,
    `reverse={${clip.reverse}}`,
    `freeze={${clip.freeze}}`,
    `loop={${clip.loop}}`,
    `fadeIn={microseconds(${clip.fades.inUs})}`,
    `fadeOut={microseconds(${clip.fades.outUs})}`,
    `x={px(${clip.transform.x})}`,
    `y={px(${clip.transform.y})}`,
    `anchorX={percent(${clip.transform.anchorX})}`,
    `anchorY={percent(${clip.transform.anchorY})}`,
    `scaleX={${clip.transform.scaleX}}`,
    `scaleY={${clip.transform.scaleY}}`,
    `rotation={deg(${clip.transform.rotation})}`,
    `opacity={${clip.transform.opacity}}`,
    `z={${clip.transform.zIndex}}`,
    `fit=${JSON.stringify(clip.transform.fit)}`,
    `cornerRadius={px(${clip.transform.cornerRadius})}`,
    `blendMode=${JSON.stringify(clip.transform.blendMode)}`,
    `gain={db(${clip.audio.gainDb})}`,
    `pan={${clip.audio.pan}}`,
    `muted={${clip.audio.muted}}`,
  ];
  const children = [
    ...(clip.content === undefined ? [] : [sceneSource(clip.content, `${indent}  `)]),
    ...clip.effects.map((effect) => effectSource(effect, `${indent}  `)),
  ];
  if (children.length === 0) return `${indent}<clip ${attributes.join(" ")} />`;
  return [`${indent}<clip ${attributes.join(" ")}>`, ...children, `${indent}</clip>`].join("\n");
}

function trackSource(track: IrTrack, indent: string): string {
  const opening = `<track id=${JSON.stringify(track.id)} kind=${JSON.stringify(track.kind)} name=${JSON.stringify(track.name)} muted={${track.muted}} locked={${track.locked}}`;
  const children = [
    ...track.clips.map((clip) => clipSource(clip, `${indent}  `)),
    ...track.effects.map((effect) => effectSource(effect, `${indent}  `)),
  ];
  if (children.length === 0) return `${indent}${opening} />`;
  return [`${indent}${opening}>`, ...children, `${indent}</track>`].join("\n");
}

function compositionSource(composition: IrComposition): string {
  const exportName = `composition_${composition.id.replaceAll(/[^a-zA-Z0-9_$]/gu, "_")}`;
  const tracks = composition.timeline.tracks.map((track) => trackSource(track, "      "));
  return [
    `export const ${exportName} = (`,
    `  <composition id=${JSON.stringify(composition.id)} name=${JSON.stringify(composition.name)} width={${composition.width}} height={${composition.height}} fps={${composition.frameRate}} background=${JSON.stringify(composition.background)}>`,
    `    <timeline id=${JSON.stringify(composition.timeline.id)}>`,
    ...tracks,
    ...composition.timeline.markers.map(
      (marker) =>
        `      <marker id=${JSON.stringify(marker.id)} at={microseconds(${marker.atUs})} name=${JSON.stringify(marker.name)}${marker.color === undefined ? "" : ` color=${JSON.stringify(marker.color)}`} />`,
    ),
    ...composition.timeline.transitions.map(
      (transition) =>
        `      <transition id=${JSON.stringify(transition.id)} from=${JSON.stringify(transition.fromClipId)} to=${JSON.stringify(transition.toClipId)} kind=${JSON.stringify(transition.kind)} duration={microseconds(${transition.durationUs})} />`,
    ),
    "    </timeline>",
    "  </composition>",
    ");",
  ].join("\n");
}

export function printNodeTemplate(template: IrNodeTemplate, indent = ""): string {
  if (template.kind === "composition") return compositionSource(template.composition);
  if (template.kind === "track") return trackSource(template.track, indent);
  if (template.kind === "clip") return clipSource(template.clip, indent);
  if (template.kind === "scene") return sceneSource(template.node, indent);
  if (template.kind === "marker")
    return `${indent}<marker id=${JSON.stringify(template.marker.id)} at={microseconds(${template.marker.atUs})} name=${JSON.stringify(template.marker.name)}${template.marker.color === undefined ? "" : ` color=${JSON.stringify(template.marker.color)}`} />`;
  return `${indent}<transition id=${JSON.stringify(template.transition.id)} from=${JSON.stringify(template.transition.fromClipId)} to=${JSON.stringify(template.transition.toClipId)} kind=${JSON.stringify(template.transition.kind)} duration={microseconds(${template.transition.durationUs})} />`;
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
  if (/^[ \t]*$/u.test(leading) && nextNewline >= 0)
    return { start: lineStart, end: nextNewline + 1 };
  return { start: span.start.offset, end: span.end.offset };
}

function compositionDeclaration(
  source: string,
  target: IrEditMap["nodes"][string]["structural"],
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
    if (item.start < start || item.end > end)
      throw new Error("A moved-node property edit escaped its source element.");
    result = `${result.slice(0, item.start - start)}${item.text}${result.slice(item.end - start)}`;
  }
  return result;
}

function insertionReplacement(
  parentId: string,
  sourceMap: IrEditMap,
  sources: Readonly<Record<string, string>>,
  template: IrNodeTemplate | string,
  anchor?: string,
): SourceReplacement {
  if (parentId === "$program") {
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
  const parent = sourceMap.nodes[parentId]?.structural;
  if (!parent) throw new Error(`No editable parent binding for ${parentId}.`);
  const source = sources[parent.element.uri];
  if (source === undefined) throw new Error(`Missing source snapshot ${parent.element.uri}.`);
  const childIndent = `${parent.style.indent}  `;
  const printed =
    typeof template === "string"
      ? template
          .split(/\r?\n/u)
          .map((line) => `${childIndent}${line}`)
          .join(parent.style.newline)
      : printNodeTemplate(template, childIndent);
  if (anchor !== undefined) {
    const before = anchor.startsWith("before:");
    const id = anchor.replace(/^(?:before|after):/u, "");
    const sibling = sourceMap.nodes[id]?.structural;
    if (!sibling || sibling.element.uri !== parent.element.uri)
      throw new Error(`Invalid insertion anchor ${anchor}.`);
    const offset = before ? sibling.element.start.offset : sibling.element.end.offset;
    return replacement(
      parent.element,
      offset,
      offset,
      before ? `${printed}${parent.style.newline}` : `${parent.style.newline}${printed}`,
    );
  }
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

function propertyReplacement(
  patch: Extract<SemanticPatch, { type: "property.set" }>,
  sourceMap: IrEditMap,
): SourceReplacement {
  const node = sourceMap.nodes[patch.nodeId];
  if (!node) throw new Error(`No editable source binding for ${patch.nodeId}.`);
  const binding = node.properties[patch.property];
  if (binding !== undefined) {
    if (!binding.scopes.includes(patch.scope))
      throw new Error(`${patch.nodeId}.${patch.property} does not allow ${patch.scope} edits.`);
    if (binding.kind === "computed" && patch.scope !== "materialized")
      throw new Error(
        `Computed property ${patch.nodeId}.${patch.property} requires materialization.`,
      );
    if (binding.kind === "default" && patch.scope === "instance") {
      if (!binding.insertion)
        throw new Error(`No instance override insertion for ${patch.nodeId}.${patch.property}.`);
      return replacement(
        binding.insertion.source,
        binding.insertion.beforeOffset,
        binding.insertion.beforeOffset,
        ` ${jsxAttribute(binding.writeProperty ?? patch.property, patch.value)}`,
      );
    }
    if (!binding.writeSpan)
      throw new Error(`Property ${patch.nodeId}.${patch.property} has no writable span.`);
    if (binding.value.kind !== patch.value.kind)
      throw new Error(`Expected ${binding.value.kind}, received ${patch.value.kind}.`);
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
  const property = getBuiltinSchema(node.structural.nodeKind)?.properties[patch.property];
  if (!property) throw new Error(`${node.structural.nodeKind} does not define ${patch.property}.`);
  if (property.type !== patch.value.kind)
    throw new Error(`Expected ${property.type}, received ${patch.value.kind}.`);
  return replacement(
    node.structural.openingElement,
    node.structural.attributeInsertionOffset,
    node.structural.attributeInsertionOffset,
    ` ${jsxAttribute(patch.property, patch.value)}`,
  );
}

export function planSemanticSourceEdits(
  patches: readonly SemanticPatch[],
  sourceMap: IrEditMap,
  sources: Readonly<Record<string, string>>,
): SourceEditPlan {
  const replacements: SourceReplacement[] = [];
  const movedNodeIds = new Set(
    patches.flatMap((patch) => (patch.type === "node.move" ? [patch.nodeId] : [])),
  );
  const deferredMoveProperties = new Map<string, SourceReplacement[]>();
  for (const patch of patches) {
    if (patch.type !== "property.set" || !movedNodeIds.has(patch.nodeId)) continue;
    const deferred = deferredMoveProperties.get(patch.nodeId) ?? [];
    deferred.push(propertyReplacement(patch, sourceMap));
    deferredMoveProperties.set(patch.nodeId, deferred);
  }
  for (const patch of patches) {
    if (patch.type === "property.set") {
      if (!movedNodeIds.has(patch.nodeId)) replacements.push(propertyReplacement(patch, sourceMap));
      continue;
    }
    if (patch.type === "property.remove") {
      const binding = sourceMap.nodes[patch.nodeId]?.properties[patch.property];
      if (!binding?.attributeSpan) {
        throw new Error(`Property ${patch.nodeId}.${patch.property} has no removable attribute.`);
      }
      let start = binding.attributeSpan.start.offset;
      const source = sources[binding.attributeSpan.uri];
      if (source?.[start - 1] === " ") start -= 1;
      replacements.push(
        replacement(binding.attributeSpan, start, binding.attributeSpan.end.offset, ""),
      );
      continue;
    }
    if (patch.type === "node.insert") {
      replacements.push(
        insertionReplacement(patch.parentId, sourceMap, sources, patch.node, patch.anchor),
      );
      continue;
    }
    const target = sourceMap.nodes[patch.nodeId]?.structural;
    if (!target || !target.safeToRemove)
      throw new Error(`Node ${patch.nodeId} is generated or has no safe structural edit lens.`);
    const source = sources[target.element.uri];
    if (source === undefined) throw new Error(`Missing source snapshot ${target.element.uri}.`);
    const range = lineRemoval(source, target.element);
    if (patch.type === "node.remove") {
      const declaration = compositionDeclaration(source, target);
      replacements.push(
        replacement(
          target.element,
          declaration?.start ?? range.start,
          declaration?.end ?? range.end,
          "",
        ),
      );
      if (declaration) {
        const defaultExport = new RegExp(
          `export\\s+default\\s+${declaration.identifier}\\s*;`,
          "u",
        ).exec(source);
        if (defaultExport) {
          const replacementIdentifier = Object.entries(sourceMap.nodes)
            .filter(
              ([id, node]) => id !== patch.nodeId && node.structural.nodeKind === "composition",
            )
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, node]) => compositionDeclaration(source, node.structural)?.identifier)
            .find((identifier): identifier is string => identifier !== undefined);
          if (!replacementIdentifier)
            throw new Error("Cannot remove the default composition without a replacement.");
          const identifierOffset =
            defaultExport.index + defaultExport[0].indexOf(declaration.identifier);
          replacements.push(
            replacement(
              target.element,
              identifierOffset,
              identifierOffset + declaration.identifier.length,
              replacementIdentifier,
            ),
          );
        }
      }
      continue;
    }
    if (patch.type === "node.replace") {
      const printed = patch.nodes
        .map((template) => printNodeTemplate(template, target.style.indent))
        .join(target.style.newline);
      replacements.push(
        replacement(
          target.element,
          target.element.start.offset,
          target.element.end.offset,
          printed.trimStart(),
        ),
      );
      continue;
    }
    if (!target.safeToMove) throw new Error(`Node ${patch.nodeId} cannot be moved safely.`);
    replacements.push(replacement(target.element, range.start, range.end, ""));
    const raw = applyNestedReplacements(
      source,
      target.element.start.offset,
      target.element.end.offset,
      deferredMoveProperties.get(patch.nodeId) ?? [],
    ).trim();
    replacements.push(insertionReplacement(patch.parentId, sourceMap, sources, raw, patch.anchor));
  }
  const ordered = [...replacements].sort(
    (left, right) =>
      left.uri.localeCompare(right.uri) || right.start - left.start || right.end - left.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (
      previous.uri === current.uri &&
      current.end > previous.start &&
      current.start !== current.end &&
      previous.start !== previous.end
    )
      throw new Error(`Overlapping source edits in ${current.uri}.`);
  }
  return {
    replacements: ordered,
    touchedUris: [...new Set(ordered.map((item) => item.uri))].sort(),
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
      .filter((replacement) => replacement.uri === uri)
      .sort((left, right) => right.start - left.start || right.end - left.end);
    const revision = revisions?.[uri] ?? edits[0]?.expectedRevision;
    if (revision !== edits[0]?.expectedRevision)
      throw new Error(`Source changed after compilation: ${uri}.`);
    for (const edit of edits) {
      if (edit.expectedRevision !== revision)
        throw new Error(`Inconsistent expected revisions for ${uri}.`);
      source = `${source.slice(0, edit.start)}${edit.text}${source.slice(edit.end)}`;
    }
    next[uri] = source;
  }
  return next;
}
