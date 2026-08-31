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

function dialogTitle(dialog: MediaBinDialog | null): string {
  if (dialog?.kind === "create-timeline") return "Create timeline";
  if (dialog?.kind === "remove-sequence") return "Delete timeline";
  return "Remove assets";
}

function CreateTimelineDescription(
  props: Pick<
    MediaBinDialogsProps,
    "selectedCount" | "timelineName" | "onTimelineNameChange" | "onCreateTimeline"
  >,
) {
  return (
    <>
      <DialogDescription>
        Place {props.selectedCount} selected {props.selectedCount === 1 ? "asset" : "assets"}{" "}
        sequentially in a new timeline.
      </DialogDescription>
      <label className="block text-ui-xs font-medium text-secondary" htmlFor="new-timeline-name">
        Timeline name
        <Input
          id="new-timeline-name"
          className="mt-1 w-full"
          maxLength={120}
          value={props.timelineName}
          onChange={(event) => props.onTimelineNameChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && props.onCreateTimeline()}
        />
      </label>
    </>
  );
}

function RemoveAssetsDescription({
  selectedCount,
  usage,
}: Pick<MediaBinDialogsProps, "selectedCount" | "usage">) {
  if (usage.lockedTrackName) {
    return (
      <DialogDescription>
        Unlock “{usage.lockedTrackName}” before removing these assets.
      </DialogDescription>
    );
  }
  return (
    <DialogDescription>
      Remove {selectedCount} {selectedCount === 1 ? "asset" : "assets"} and {usage.clipCount}{" "}
      {usage.clipCount === 1 ? "clip" : "clips"} across {usage.affectedTimelineCount}{" "}
      {usage.affectedTimelineCount === 1 ? "timeline" : "timelines"}? Original source files will not
      be deleted.
    </DialogDescription>
  );
}

function RemoveSequenceDescription({
  pendingSequence,
  sequenceCount,
}: Pick<MediaBinDialogsProps, "pendingSequence" | "sequenceCount">) {
  if (!pendingSequence) return null;
  if (sequenceCount === 1)
    return <DialogDescription>A project must keep at least one timeline.</DialogDescription>;
  if (pendingSequence.tracks.some((track) => track.locked)) {
    return <DialogDescription>Unlock every track before deleting this timeline.</DialogDescription>;
  }
  const clipCount = pendingSequence.tracks.reduce((count, track) => count + track.clips.length, 0);
  return (
    <DialogDescription>
      Delete “{pendingSequence.name}” and its {clipCount} clips? Assets remain in the Media tab.
    </DialogDescription>
  );
}

function DialogBody(props: MediaBinDialogsProps) {
  if (props.dialog?.kind === "create-timeline") return <CreateTimelineDescription {...props} />;
  if (props.dialog?.kind === "remove-assets") return <RemoveAssetsDescription {...props} />;
  return <RemoveSequenceDescription {...props} />;
}

function DialogAction(props: MediaBinDialogsProps) {
  if (props.dialog?.kind === "create-timeline") {
    return (
      <Button
        variant="primary"
        disabled={!props.timelineName.trim()}
        onClick={props.onCreateTimeline}
      >
        Create Timeline
      </Button>
    );
  }
  if (props.dialog?.kind === "remove-assets") {
    return (
      <Button
        variant="danger"
        disabled={Boolean(props.usage.lockedTrackName)}
        onClick={props.onRemoveAssets}
      >
        Remove Assets
      </Button>
    );
  }
  if (!props.pendingSequence) return null;
  const locked = props.pendingSequence.tracks.some((track) => track.locked);
  return (
    <Button
      variant="danger"
      disabled={props.sequenceCount === 1 || locked}
      onClick={() => props.onRemoveSequence(props.pendingSequence!)}
    >
      Delete Timeline
    </Button>
  );
}

export function MediaBinDialogs(props: MediaBinDialogsProps) {
  const { dialog, onClose } = props;
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{dialogTitle(dialog)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 p-4">
          <DialogBody {...props} />
        </div>
        <DialogFooter className="border-t border-border p-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <DialogAction {...props} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
