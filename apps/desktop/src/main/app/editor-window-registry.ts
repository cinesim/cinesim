import type { BrowserWindow } from "electron";
import type { DesktopEventContract } from "../../shared/contracts/events";

type EventArguments<TPayload> = TPayload extends void ? [] : [payload: TPayload];

export class EditorWindowRegistry {
  readonly #windows = new Set<BrowserWindow>();

  register(window: BrowserWindow): void {
    this.#windows.add(window);
    window.once("closed", () => this.#windows.delete(window));
  }

  get size(): number {
    this.#removeDestroyed();
    return this.#windows.size;
  }

  primary(): BrowserWindow | null {
    this.#removeDestroyed();
    return this.#windows.values().next().value ?? null;
  }

  focusPrimary(options: { show?: boolean } = {}): BrowserWindow | null {
    const target = this.primary();
    if (!target) return null;
    if (target.isMinimized()) target.restore();
    if (options.show) target.show();
    target.focus();
    return target;
  }

  broadcast<TPayload>(
    contract: DesktopEventContract<TPayload>,
    ...arguments_: EventArguments<TPayload>
  ): void {
    this.#removeDestroyed();
    for (const target of this.#windows) target.webContents.send(contract.channel, ...arguments_);
  }

  sendPrimary<TPayload>(
    contract: DesktopEventContract<TPayload>,
    ...arguments_: EventArguments<TPayload>
  ): void {
    this.primary()?.webContents.send(contract.channel, ...arguments_);
  }

  #removeDestroyed(): void {
    for (const target of this.#windows) if (target.isDestroyed()) this.#windows.delete(target);
  }
}
