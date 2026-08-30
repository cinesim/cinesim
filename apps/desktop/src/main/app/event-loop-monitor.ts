const EVENT_LOOP_SAMPLE_INTERVAL_MS = 100;
const EVENT_LOOP_SAMPLE_WINDOW = 20;
const EVENT_LOOP_REPORT_PERCENTILE = 0.95;

export class MainEventLoopMonitor {
  #probe: NodeJS.Timeout | null = null;
  #expectedAt = 0;
  #lagSamples: number[] = [];

  start(): void {
    if (this.#probe) return;
    this.#expectedAt = performance.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS;
    this.#probe = setInterval(() => {
      const now = performance.now();
      this.#lagSamples.push(Math.max(0, now - this.#expectedAt));
      if (this.#lagSamples.length > EVENT_LOOP_SAMPLE_WINDOW) this.#lagSamples.shift();
      this.#expectedAt = now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
    }, EVENT_LOOP_SAMPLE_INTERVAL_MS);
    this.#probe.unref();
  }

  takeP95(): number {
    const sorted = this.#lagSamples.toSorted((left, right) => left - right);
    this.#lagSamples = [];
    return sorted[Math.max(0, Math.ceil(sorted.length * EVENT_LOOP_REPORT_PERCENTILE) - 1)] ?? 0;
  }

  stop(): void {
    if (!this.#probe) return;
    clearInterval(this.#probe);
    this.#probe = null;
  }
}
