import type { MouseEvent, PointerEvent } from "react";
import type { Asset } from "@cinesim/core";
import { cn } from "@cinesim/ui";
import { useRendererStore } from "../../store/renderer-store-context";

const labels = {
  missing: "Generate transcript",
  queued: "Cancel queued transcript",
  running: "Cancel transcription",
  ready: "Regenerate transcript",
  failed: "Retry transcript",
} as const;

function supported(asset: Asset): boolean {
  return asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio === true);
}

function stateClass(state: keyof typeof labels): string {
  if (state === "ready") return "border-accent/60 bg-accent/15 text-accent";
  if (state === "failed") return "border-red-400/50 bg-red-400/10 text-red-300";
  if (state === "queued" || state === "running")
    return "animate-pulse border-primary/40 bg-primary/10 text-primary";
  return "border-border-strong bg-panel/90 text-secondary";
}

export function MediaTranscriptBadge({
  asset,
  className,
  interactive = false,
}: {
  asset: Asset;
  className?: string;
  interactive?: boolean;
}) {
  const transcript = useRendererStore((state) => state.transcripts?.assets[asset.id]);
  const account = useRendererStore((state) => state.account);
  const request = useRendererStore((state) => state.requestTranscripts);
  const regenerate = useRendererStore((state) => state.regenerateTranscripts);
  const cancel = useRendererStore((state) => state.cancelTranscripts);
  if (!supported(asset)) return null;
  const state = transcript?.state ?? "missing";
  const available = account.status === "signed-in" && account.transcription;
  const disabled = !available && state !== "queued" && state !== "running";
  const activate = (): void => {
    if (state === "queued" || state === "running") void cancel([asset.id]);
    else if (state === "ready") void regenerate([asset.id]);
    else void request([asset.id]);
  };
  const stopPointer = (event: PointerEvent<HTMLButtonElement>): void => event.stopPropagation();
  const click = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    activate();
  };
  const badgeClassName = cn(
    "inline-flex h-5 shrink-0 items-center rounded border px-1 text-[9px] font-semibold tracking-wide",
    stateClass(state),
    className,
  );
  if (!interactive)
    return (
      <span className={badgeClassName} title={labels[state]}>
        CC
      </span>
    );
  return (
    <button
      type="button"
      className={badgeClassName}
      aria-label={`${labels[state]} for ${asset.name}`}
      title={disabled ? "Sign in to transcribe" : labels[state]}
      disabled={disabled}
      onPointerDown={stopPointer}
      onClick={click}
    >
      CC
    </button>
  );
}
