export type RenderGraphLayerKind = "media" | "graphic" | "text";

export interface RenderGraphLayer {
  id: string;
  kind: RenderGraphLayerKind;
  painterOrder: number;
  effectCount: number;
  masked: boolean;
  groupDepth: number;
  blendMode: string;
}

export interface RenderGraphNode {
  id: string;
  kind: "source" | "effects" | "mask" | "group" | "composite" | "output";
  inputs: string[];
  layerId?: string;
  textureSlot?: number;
}

export interface RenderGraphAdjustment {
  id: string;
  targetLayerIds: string[];
  painterOrder: number;
  effectCount: number;
}

export interface RenderGraph {
  nodes: RenderGraphNode[];
  painterOrder: string[];
  intermediateTextureCount: number;
}

interface CompositeUnit {
  nodeId: string;
  operationId: string;
  painterOrder: number;
}

const MAX_GRAPH_LAYERS = 2048;
const MAX_GRAPH_NODES = 8192;
const MAX_INTERMEDIATE_TEXTURES = 4;

function checkedLayers(layers: readonly RenderGraphLayer[]): RenderGraphLayer[] {
  if (layers.length > MAX_GRAPH_LAYERS)
    throw new Error(`Render graph exceeds the ${MAX_GRAPH_LAYERS}-layer limit.`);
  const ids = new Set<string>();
  const ordered = [...layers].sort(
    (left, right) => left.painterOrder - right.painterOrder || left.id.localeCompare(right.id),
  );
  for (const layer of ordered) {
    if (!layer.id || ids.has(layer.id))
      throw new Error(`Duplicate render-graph layer: ${layer.id}`);
    ids.add(layer.id);
  }
  return ordered;
}

function layerNodes(layer: RenderGraphLayer): RenderGraphNode[] {
  const source = `${layer.id}:source`;
  const nodes: RenderGraphNode[] = [{ id: source, kind: "source", inputs: [], layerId: layer.id }];
  let input = source;
  if (layer.effectCount > 0) {
    input = `${layer.id}:effects`;
    nodes.push({ id: input, kind: "effects", inputs: [source], layerId: layer.id, textureSlot: 0 });
  }
  if (layer.masked) {
    const mask = `${layer.id}:mask`;
    nodes.push({ id: mask, kind: "mask", inputs: [input], layerId: layer.id, textureSlot: 1 });
    input = mask;
  }
  if (layer.groupDepth > 0) {
    const group = `${layer.id}:group`;
    nodes.push({ id: group, kind: "group", inputs: [input], layerId: layer.id, textureSlot: 2 });
  }
  return nodes;
}

function terminalNodeId(layer: RenderGraphLayer): string {
  if (layer.groupDepth > 0) return `${layer.id}:group`;
  if (layer.masked) return `${layer.id}:mask`;
  if (layer.effectCount > 0) return `${layer.id}:effects`;
  return `${layer.id}:source`;
}

export function buildRenderGraph(
  layers: readonly RenderGraphLayer[],
  adjustments: readonly RenderGraphAdjustment[] = [],
): RenderGraph {
  const ordered = checkedLayers(layers);
  const nodes = ordered.flatMap(layerNodes);
  const byId = new Map(ordered.map((layer) => [layer.id, layer]));
  const claimed = new Set<string>();
  const operationIds = new Set(ordered.map((layer) => layer.id));
  const adjustmentUnits: CompositeUnit[] = [];
  for (const adjustment of adjustments) {
    if (!adjustment.id || operationIds.has(adjustment.id))
      throw new Error(`Duplicate render-graph operation: ${adjustment.id}`);
    operationIds.add(adjustment.id);
    const targetLayers = adjustment.targetLayerIds
      .map((id) => {
        const layer = byId.get(id);
        if (!layer || claimed.has(id)) throw new Error(`Invalid adjustment render target: ${id}`);
        claimed.add(id);
        return layer;
      })
      .sort(
        (left, right) => left.painterOrder - right.painterOrder || left.id.localeCompare(right.id),
      );
    if (targetLayers.length === 0)
      throw new Error(`Adjustment render group has no targets: ${adjustment.id}`);
    const groupId = `${adjustment.id}:group`;
    nodes.push({
      id: groupId,
      kind: "group",
      inputs: targetLayers.map(terminalNodeId),
      layerId: adjustment.id,
      textureSlot: 2,
    });
    let nodeId = groupId;
    if (adjustment.effectCount > 0)
      nodes.push({
        id: (nodeId = `${adjustment.id}:effects`),
        kind: "effects",
        inputs: [groupId],
        layerId: adjustment.id,
        textureSlot: 0,
      });
    adjustmentUnits.push({
      nodeId,
      operationId: adjustment.id,
      painterOrder: adjustment.painterOrder,
    });
  }
  const units: CompositeUnit[] = [
    ...ordered
      .filter((layer) => !claimed.has(layer.id))
      .map((layer) => ({
        nodeId: terminalNodeId(layer),
        operationId: layer.id,
        painterOrder: layer.painterOrder,
      })),
    ...adjustmentUnits,
  ].sort(
    (left, right) =>
      left.painterOrder - right.painterOrder || left.operationId.localeCompare(right.operationId),
  );
  nodes.push({
    id: "scene:composite",
    kind: "composite",
    inputs: units.map(({ nodeId }) => nodeId),
    textureSlot: 3,
  });
  nodes.push({ id: "scene:output", kind: "output", inputs: ["scene:composite"] });
  if (nodes.length > MAX_GRAPH_NODES)
    throw new Error(`Render graph exceeds the ${MAX_GRAPH_NODES}-node limit.`);
  const intermediateTextureCount = Math.min(
    MAX_INTERMEDIATE_TEXTURES,
    Math.max(1, ...nodes.flatMap((node) => node.textureSlot ?? -1).map((slot) => slot + 1)),
  );
  return {
    nodes,
    painterOrder: units.map(({ operationId }) => operationId),
    intermediateTextureCount,
  };
}
