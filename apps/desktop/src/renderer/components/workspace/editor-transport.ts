import type { AssetId, TimeUs } from "@cinesim/core";
import type { ViewerController } from "../viewer/use-viewer-runtime";

interface EditorTransportOptions {
  isPlaying: () => boolean;
  setPlayheadUs: (timeUs: TimeUs) => void;
}

export class EditorTransportController {
  readonly #isPlaying: () => boolean;
  readonly #setPlayheadUs: (timeUs: TimeUs) => void;
  #controller: ViewerController | null = null;
  #rangeEndUs: TimeUs | null = null;

  constructor({ isPlaying, setPlayheadUs }: EditorTransportOptions) {
    this.#isPlaying = isPlaying;
    this.#setPlayheadUs = setPlayheadUs;
  }

  registerController = (controller: ViewerController | null): void => {
    this.#controller = controller;
    if (!controller) this.#rangeEndUs = null;
  };

  observePlayback(playheadUs: TimeUs, playing: boolean): void {
    if (!playing || this.#rangeEndUs === null || playheadUs < this.#rangeEndUs) return;
    this.#rangeEndUs = null;
    this.#controller?.pauseTimeline();
  }

  seekTimeline = async (timeUs: TimeUs): Promise<void> => {
    this.#rangeEndUs = null;
    await this.#seekTimeline(timeUs);
  };

  togglePlayback = (): void => {
    this.#rangeEndUs = null;
    if (this.#isPlaying()) this.#controller?.pauseTimeline();
    else this.#controller?.playTimeline();
  };

  shuttle = (direction: -1 | 0 | 1): void => {
    this.#rangeEndUs = null;
    this.#controller?.shuttle(direction);
  };

  stepFrames = async (deltaFrames: number): Promise<void> => {
    this.#rangeEndUs = null;
    await this.#controller?.stepFrames(deltaFrames);
  };

  previewAsset = (assetId: AssetId, sourceTimeUs: TimeUs): void => {
    this.#rangeEndUs = null;
    this.#controller?.enterAssetPreview(assetId, sourceTimeUs);
  };

  exitAssetPreview = async (): Promise<void> => {
    await this.#controller?.exitAssetPreview();
  };

  playRange = async (startUs: TimeUs, endUs: TimeUs): Promise<void> => {
    const controller = this.#controller;
    if (!controller || endUs <= startUs) return;
    this.#rangeEndUs = endUs;
    this.#setPlayheadUs(startUs);
    await controller.seekTimeline(startUs);
    if (this.#controller === controller && this.#rangeEndUs === endUs) controller.playTimeline();
  };

  async #seekTimeline(timeUs: TimeUs): Promise<void> {
    this.#setPlayheadUs(timeUs);
    await this.#controller?.seekTimeline(timeUs);
  }
}
