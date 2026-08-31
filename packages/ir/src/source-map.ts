import type { IrEditMap, IrEditMapNode, IrPropertyBinding, IrStructuralBinding } from "./types";

export interface EditMapBuilderNode {
  structural: IrStructuralBinding;
  properties: IrPropertyBinding[];
  animations?: IrEditMapNode["animations"];
}

export function createIrSourceMap(
  entry: string,
  sources: IrEditMap["sources"],
  bindings: readonly EditMapBuilderNode[],
): IrEditMap {
  return {
    version: 2,
    entry,
    sources: [...sources].sort((left, right) => left.uri.localeCompare(right.uri)),
    nodes: Object.fromEntries(
      [...bindings]
        .sort((left, right) => left.structural.nodeId.localeCompare(right.structural.nodeId))
        .map((binding) => [
          binding.structural.nodeId,
          {
            structural: binding.structural,
            properties: Object.fromEntries(
              binding.properties.map((property) => [property.property, property]),
            ),
            animations: binding.animations ?? [],
          },
        ]),
    ),
  };
}
