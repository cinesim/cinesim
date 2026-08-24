export type AdaptiveDecision =
  | "observing"
  | "original-sufficient"
  | "proxy-queued"
  | "proxy-ready"
  | "proxy-failed";

export interface AdaptivePolicyInput {
  observations: number;
  warmSeekP95Ms?: number;
  deadlineMissRate?: number;
  requestsReceived: number;
  requestsCoalesced: number;
  proxyState: "missing" | "queued" | "running" | "ready" | "failed";
  diskHeadroomAvailable: boolean;
}

export interface AdaptivePolicyResult {
  decision: AdaptiveDecision;
  reasons: string[];
  queueProxy: boolean;
}

export function evaluateAdaptivePolicy(input: AdaptivePolicyInput): AdaptivePolicyResult {
  if (input.proxyState === "ready")
    return { decision: "proxy-ready", reasons: ["proxy-already-valid"], queueProxy: false };
  if (input.proxyState === "running" || input.proxyState === "queued")
    return { decision: "proxy-queued", reasons: ["proxy-generation-active"], queueProxy: false };
  if (input.proxyState === "failed")
    return { decision: "proxy-failed", reasons: ["proxy-generation-failed"], queueProxy: false };
  if (input.observations < 5)
    return { decision: "observing", reasons: ["insufficient-observations"], queueProxy: false };

  const reasons: string[] = [];
  if ((input.warmSeekP95Ms ?? 0) > 125) reasons.push("warm-seek-p95-over-budget");
  if ((input.deadlineMissRate ?? 0) > 0.05) reasons.push("playback-deadline-miss-rate");
  if (
    input.requestsReceived >= 5 &&
    input.requestsCoalesced / Math.max(1, input.requestsReceived) > 0.15
  )
    reasons.push("request-backlog-sustained");
  if (reasons.length === 0)
    return { decision: "original-sufficient", reasons: ["original-sufficient"], queueProxy: false };
  if (!input.diskHeadroomAvailable)
    return {
      decision: "observing",
      reasons: [...reasons, "insufficient-disk-headroom"],
      queueProxy: false,
    };
  return { decision: "proxy-queued", reasons, queueProxy: true };
}
