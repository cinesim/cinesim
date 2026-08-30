import type { Sequence } from "@cinesim/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@cinesim/ui";
import type { AssetUsageSummary } from "./media-bin-model";

export type MediaBinDialog =
  | { kind: "create-timeline" }
  | { kind: "remove-assets" }
  | { kind: "remove-sequence"; sequenceId: string };

interface MediaBinDialogsProps {
  dialog: MediaBinDialog | null;
  onClose: () => void;
  onCreateTimeline: () => void;
  onRemoveAssets: () => void;
  onRemoveSequence: (sequence: Sequence) => void;
  pendingSequence: Sequence | null;
  selectedCount: number;
  sequenceCount: number;
  timelineName: string;
  usage: AssetUsageSummary;
  onTimelineNameChange: (name: string) => void;
}

export function MediaBinDialogs({
  dialog,
  onClose,
  onCreateTimeline,
  onRemoveAssets,
  onRemoveSequence,
  pendingSequence,
  selectedCount,
  sequenceCount,
  timelineName,
  usage,
  onTimelineNameChange,
}: MediaBinDialogsProps) {
  const sequenceHasLockedTracks = pendingSequence?.tracks.some((track) => track.locked) ?? false;

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {dialog?.kind === "create-timeline"
              ? "Create timeline"
              : dialog?.kind === "remove-sequence"
                ? "Delete timeline"
                : "Remove assets"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 p-4">
          {dialog?.kind === "create-timeline" ? (
            <>
              <DialogDescription>
                Place {selectedCount} selected {selectedCount === 1 ? "asset" : "assets"}{" "}
                sequentially in a new timeline.
              </DialogDescription>
              <label
                className="block text-ui-xs font-medium text-secondary"
                htmlFor="new-timeline-name"
              >
                Timeline name
                <Input
                  id="new-timeline-name"
                  className="mt-1 w-full"
                  maxLength={120}
                  value={timelineName}
                  onChange={(event) => onTimelineNameChange(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && onCreateTimeline()}
                />
              </label>
            </>
          ) : dialog?.kind === "remove-assets" ? (
            <DialogDescription>
              {usage.lockedTrackName
                ? `Unlock “${usage.lockedTrackName}” before removing these assets.`
                : `Remove ${selectedCount} ${selectedCount === 1 ? "asset" : "assets"} and ${usage.clipCount} ${usage.clipCount === 1 ? "clip" : "clips"} across ${usage.affectedTimelineCount} ${usage.affectedTimelineCount === 1 ? "timeline" : "timelines"}? Original source files will not be deleted.`}
            </DialogDescription>
          ) : pendingSequence ? (
            <DialogDescription>
              {sequenceCount === 1
                ? "A project must keep at least one timeline."
                : sequenceHasLockedTracks
                  ? "Unlock every track before deleting this timeline."
                  : `Delete “${pendingSequence.name}” and its ${pendingSequence.tracks.reduce((count, track) => count + track.clips.length, 0)} clips? Assets remain in the Media tab.`}
            </DialogDescription>
          ) : null}
        </div>
        <DialogFooter className="border-t border-border p-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {dialog?.kind === "create-timeline" ? (
            <Button variant="primary" disabled={!timelineName.trim()} onClick={onCreateTimeline}>
              Create Timeline
            </Button>
          ) : dialog?.kind === "remove-assets" ? (
            <Button
              variant="danger"
              disabled={Boolean(usage.lockedTrackName)}
              onClick={onRemoveAssets}
            >
              Remove Assets
            </Button>
          ) : pendingSequence ? (
            <Button
              variant="danger"
              disabled={sequenceCount === 1 || sequenceHasLockedTracks}
              onClick={() => onRemoveSequence(pendingSequence)}
            >
              Delete Timeline
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
