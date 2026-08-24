import type { ProcessMetric } from "electron";
import type {
  ElectronHealthSnapshot,
  ElectronProcessGroupKind,
  ElectronProcessGroupMetric,
} from "../shared/api";

const PROCESS_GROUPS: ElectronProcessGroupKind[] = ["main", "renderer", "gpu", "utility", "other"];

export function electronHealthSnapshot(
  metrics: ProcessMetric[],
  mainEventLoopLagMs: number,
  sampledAt = new Date().toISOString(),
): ElectronHealthSnapshot {
  const processes = Object.fromEntries(
    PROCESS_GROUPS.map((kind) => [kind, emptyProcessGroup()]),
  ) as Record<ElectronProcessGroupKind, ElectronProcessGroupMetric>;

  for (const metric of metrics) {
    const group = processes[processGroup(metric.type)];
    group.cpuPercent += finiteNonnegative(metric.cpu.percentCPUUsage);
    group.memoryBytes += finiteNonnegative(metric.memory.workingSetSize) * 1024;
    group.processCount += 1;
  }

  return {
    sampledAt,
    totalCpuPercent: sumGroups(processes, "cpuPercent"),
    totalMemoryBytes: sumGroups(processes, "memoryBytes"),
    processCount: sumGroups(processes, "processCount"),
    mainEventLoopLagMs: finiteNonnegative(mainEventLoopLagMs),
    rendererEventLoopLagMs: null,
    processes,
  };
}

function processGroup(type: ProcessMetric["type"]): ElectronProcessGroupKind {
  if (type === "Browser") return "main";
  if (type === "Tab") return "renderer";
  if (type === "GPU") return "gpu";
  if (type === "Utility") return "utility";
  return "other";
}

function emptyProcessGroup(): ElectronProcessGroupMetric {
  return { cpuPercent: 0, memoryBytes: 0, processCount: 0 };
}

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sumGroups(
  groups: Record<ElectronProcessGroupKind, ElectronProcessGroupMetric>,
  key: keyof ElectronProcessGroupMetric,
): number {
  return PROCESS_GROUPS.reduce((total, group) => total + groups[group][key], 0);
}
