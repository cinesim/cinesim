export class MainEventLoopMonitor {
  #probe: NodeJS.Timeout | null = null;
  #expectedAt = 0;
  #lagSamples: number[] = [];

  start(): void {
    if (this.#probe) return;
    this.#expectedAt = performance.now() + 100;
    this.#probe = setInterval(() => {
      const now = performance.now();
      this.#lagSamples.push(Math.max(0, now - this.#expectedAt));
      if (this.#lagSamples.length > 20) this.#lagSamples.shift();
      this.#expectedAt = now + 100;
    }, 100);
    this.#probe.unref();
  }

  takeP95(): number {
    const sorted = this.#lagSamples.toSorted((left, right) => left - right);
    this.#lagSamples = [];
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  }

  stop(): void {
    if (!this.#probe) return;
    clearInterval(this.#probe);
    this.#probe = null;
  }
}
