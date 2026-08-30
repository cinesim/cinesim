import { rm } from "node:fs/promises";
import type { Asset, Project, ProjectSettings } from "@cinesim/core";
import type {
  DerivedArtifactKind,
  DerivedMediaEvent,
  DerivedMediaSnapshot,
  DerivedProjectScope,
} from "../../shared/contracts";
import type { DerivedArtifactRepository } from "./artifact-repository";
import { projectOpenPersistenceSignature } from "./model";
import type { PersistedAsset, PersistedIndex } from "./model";

interface DerivedJobHost {
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  assertScope(scope: DerivedProjectScope): void;
  project(): Project;
  settings(): ProjectSettings;
  index(): PersistedIndex;
  asset(assetId: string): Asset;
  ensureAsset(asset: Asset): Promise<PersistedAsset>;
  containedPath(relativePath: string): string;
  persist(): Promise<void>;
  emit(): void;
  snapshot(): DerivedMediaSnapshot;
  subscribe(listener: (snapshot: DerivedMediaSnapshot) => void): () => void;
  log(event: Omit<DerivedMediaEvent, "at">): void;
}

export class DerivedJobCoordinator {
  constructor(
    private readonly host: DerivedJobHost,
    private readonly artifacts: DerivedArtifactRepository,
  ) {}

  async request(scope: DerivedProjectScope, assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.host.serialize(async () => {
      this.host.assertScope(scope);
      return this.#queueRequestedArtifacts(assetIds, true);
    });
  }

  async queuePerception(assetIds: string[]): Promise<DerivedMediaSnapshot> {
    return this.host.serialize(() => this.#queueRequestedArtifacts(assetIds, false));
  }

  async waitForPerception(assetId: string, signal?: AbortSignal): Promise<void> {
    const terminal = (snapshot: DerivedMediaSnapshot): boolean => {
      const asset = this.host.asset(assetId);
      const record = snapshot.assets[assetId];
      if (!record) return false;
      const kinds: DerivedArtifactKind[] = [];
      if (asset.kind === "video") kinds.push("thumbnail", "filmstrip");
      if (asset.kind === "audio" || asset.hasAudio === true) kinds.push("waveform");
      return kinds.every(
        (kind) => record[kind].state === "ready" || record[kind].state === "failed",
      );
    };
    if (terminal(this.host.snapshot())) return;
    if (signal?.aborted) throw new Error("Cloud transfer canceled");
    await new Promise<void>((resolve, reject) => {
      let stop: () => void = () => undefined;
      let settled = false;
      const abort = () => {
        settled = true;
        stop();
        reject(new Error("Cloud transfer canceled"));
      };
      stop = this.host.subscribe((snapshot) => {
        if (!terminal(snapshot)) return;
        settled = true;
        stop();
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      if (settled) stop();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }
    });
  }

  async queueProxy(assetId: string): Promise<DerivedMediaSnapshot> {
    return this.host.serialize(async () => {
      const asset = this.host.asset(assetId);
      if (asset.kind !== "video" && asset.kind !== "audio")
        throw new Error("This media type does not support edit proxies yet");
      await this.queueProxyRecord(asset, true);
      await this.host.persist();
      this.host.emit();
      return this.host.snapshot();
    });
  }

  async queueProxies(
    scope: DerivedProjectScope,
    assetIds: string[],
  ): Promise<DerivedMediaSnapshot> {
    this.host.assertScope(scope);
    if (assetIds.length === 0 || assetIds.length > 100)
      throw new Error("Invalid proxy job request");
    for (const assetId of new Set(assetIds)) await this.queueProxy(assetId);
    return this.host.snapshot();
  }

  async waitForProxy(assetId: string, signal?: AbortSignal): Promise<void> {
    const current = this.host.snapshot().assets[assetId]?.proxy;
    if (current?.state === "ready") return;
    if (current?.state === "failed") throw new Error("The edit proxy could not be generated");
    await new Promise<void>((resolve, reject) => {
      const stop = this.host.subscribe((snapshot) => {
        const proxy = snapshot.assets[assetId]?.proxy;
        if (proxy?.state === "ready") {
          stop();
          signal?.removeEventListener("abort", abort);
          resolve();
        } else if (proxy?.state === "failed") {
          stop();
          signal?.removeEventListener("abort", abort);
          reject(new Error("The edit proxy could not be generated"));
        }
      });
      const abort = () => {
        stop();
        reject(new Error("Cloud transfer canceled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async queueProxyRecord(asset: Asset, required = false): Promise<void> {
    if (asset.kind !== "video" && asset.kind !== "audio") return;
    if (!this.artifacts.diskHeadroomAvailable) {
      if (required) throw new Error("Insufficient disk headroom for a proxy");
      return;
    }
    const record = await this.host.ensureAsset(asset);
    const profileId = this.#proxyProfileId();
    if (record.proxy.state === "ready" && record.proxy.profileId !== profileId) {
      if (record.proxy.relativePath)
        await rm(this.host.containedPath(record.proxy.relativePath), { force: true });
      record.proxy.state = "missing";
      delete record.proxy.relativePath;
      delete record.proxy.bytes;
      delete record.proxy.updatedAt;
      delete record.proxy.lastAccessAt;
    }
    if (record.proxy.state === "queued") record.proxy.profileId = profileId;
    if (record.proxy.state === "missing" || record.proxy.state === "failed") {
      record.proxy.state = "queued";
      record.proxy.progress = 0;
      record.proxy.profileId = profileId;
      delete record.proxy.failureCode;
      this.host.log({
        assetId: asset.id,
        kind: "proxy-queued",
        detail: `Edit proxy queued with ${profileId}`,
      });
    }
  }

  async #queueRequestedArtifacts(
    assetIds: string[],
    queueConfiguredProxies: boolean,
  ): Promise<DerivedMediaSnapshot> {
    if (assetIds.length > 500) throw new Error("Too many derived job requests");
    const index = this.host.index();
    const persistenceSignature = projectOpenPersistenceSignature(index);
    const project = this.host.project();
    for (const assetId of new Set(assetIds)) {
      const asset = project.assets.find((candidate) => candidate.id === assetId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) continue;
      const record = await this.host.ensureAsset(asset);
      const kinds: DerivedArtifactKind[] = [];
      if (asset.kind === "video") kinds.push("thumbnail", "filmstrip");
      if (asset.kind === "audio" || asset.hasAudio === true) kinds.push("waveform");
      for (const kind of kinds) {
        const artifact = record[kind];
        if (artifact.state === "missing") artifact.state = "queued";
      }
      if (
        queueConfiguredProxies &&
        (this.host.settings().proxyGeneration === "automatic" || asset.source.kind === "cloud")
      )
        await this.queueProxyRecord(asset);
    }
    if (projectOpenPersistenceSignature(index) !== persistenceSignature) await this.host.persist();
    this.host.emit();
    return this.host.snapshot();
  }

  #proxyProfileId(): string {
    const settings = this.host.settings();
    return [
      settings.proxyProfile,
      settings.proxyMaxLongEdge,
      settings.proxyFrameRateCap,
      settings.proxyQuality,
    ].join("-");
  }
}
