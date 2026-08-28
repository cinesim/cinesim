import { describe, expect, it } from "vite-plus/test";
import type { ProcessMetric } from "electron";
import { electronHealthSnapshot } from "../src/main/app/health";

function metric(
  type: ProcessMetric["type"],
  cpuPercent: number,
  workingSetKilobytes: number,
): ProcessMetric {
  return {
    pid: 1,
    type,
    creationTime: 0,
    cpu: { percentCPUUsage: cpuPercent, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: workingSetKilobytes, peakWorkingSetSize: workingSetKilobytes },
  };
}

describe("electron health metrics", () => {
  it("aggregates bounded process groups and converts working sets to bytes", () => {
    const snapshot = electronHealthSnapshot(
      [
        metric("Browser", 8, 100),
        metric("Tab", 20, 200),
        metric("Tab", 5, 50),
        metric("GPU", 10, 300),
        metric("Utility", 2, 25),
        metric("Sandbox helper", Number.NaN, -1),
      ],
      4.5,
      "2026-08-23T00:00:00.000Z",
    );

    expect(snapshot).toMatchObject({
      sampledAt: "2026-08-23T00:00:00.000Z",
      totalCpuPercent: 45,
      totalMemoryBytes: 675 * 1024,
      processCount: 6,
      mainEventLoopLagMs: 4.5,
      rendererEventLoopLagMs: null,
      processes: {
        main: { cpuPercent: 8, memoryBytes: 100 * 1024, processCount: 1 },
        renderer: { cpuPercent: 25, memoryBytes: 250 * 1024, processCount: 2 },
        gpu: { cpuPercent: 10, memoryBytes: 300 * 1024, processCount: 1 },
        utility: { cpuPercent: 2, memoryBytes: 25 * 1024, processCount: 1 },
        other: { cpuPercent: 0, memoryBytes: 0, processCount: 1 },
      },
    });
  });
});
