import type { IrDocument, IrNode, IrSourceMap } from "./types";

export function createIrSourceMap(document: IrDocument): IrSourceMap {
  const nodes: IrSourceMap["nodes"] = {};

  function visit(node: IrNode): void {
    nodes[node.id] = {
      origin: node.origin,
      componentStack: node.componentStack,
      animations: node.animations.map((animation) => ({
        property: animation.property,
        origin: animation.origin,
        keyframes: animation.keyframes.map((keyframe) => ({
          origin: keyframe.origin,
          at: {
            source: keyframe.edits.at.source,
            expected: keyframe.edits.at.expected,
            strategy: keyframe.edits.at.strategy,
          },
          value: {
            source: keyframe.edits.value.source,
            expected: keyframe.edits.value.expected,
            strategy: keyframe.edits.value.strategy,
          },
        })),
      })),
      properties: Object.fromEntries(
        Object.entries(node.props).map(([name, property]) => [
          name,
          {
            source: property.edit.source,
            expected: property.edit.expected,
            strategy: property.edit.strategy,
          },
        ]),
      ),
    };
    for (const child of node.children) visit(child);
  }

  visit(document.root);
  return { version: 1, entry: document.entry, nodes };
}
