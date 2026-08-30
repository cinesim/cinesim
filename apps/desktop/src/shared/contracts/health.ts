export type ElectronProcessGroupKind = "main" | "renderer" | "gpu" | "utility" | "other";

export interface ElectronProcessGroupMetric {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

export interface ElectronHealthSnapshot {
  sampledAt: string;
  totalCpuPercent: number;
  totalMemoryBytes: number;
  processCount: number;
  mainEventLoopLagMs: number;
  rendererEventLoopLagMs: number | null;
  processes: Record<ElectronProcessGroupKind, ElectronProcessGroupMetric>;
}
