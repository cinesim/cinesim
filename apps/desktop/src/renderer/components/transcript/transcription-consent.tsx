import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetId } from "@cinesim/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cinesim/ui";

function consentKey(userId: string): string {
  return `cinesim.transcriptionRemoteConsent.${userId}`;
}

export function grantTranscriptionConsent(userId: string): void {
  localStorage.setItem(consentKey(userId), "true");
}

export function useTranscriptionConsent(
  userId: string | null,
  onApproved: (assetIds: AssetId[]) => Promise<unknown>,
) {
  const approvedAction = useRef(onApproved);
  const [pendingAssetIds, setPendingAssetIds] = useState<AssetId[] | null>(null);

  useEffect(() => {
    approvedAction.current = onApproved;
  }, [onApproved]);

  const request = useCallback(
    (assetIds: AssetId[]) => {
      if (!userId || assetIds.length === 0) return;
      if (localStorage.getItem(consentKey(userId)) === "true") {
        void approvedAction.current(assetIds);
        return;
      }
      setPendingAssetIds(assetIds);
    },
    [userId],
  );

  const dialog = (
    <Dialog
      open={pendingAssetIds !== null}
      onOpenChange={(open) => {
        if (!open) setPendingAssetIds(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send audio for transcription?</DialogTitle>
          <DialogDescription>
            Cinesim will send bounded audio chunks directly to Deepgram Nova-3. Audio leaves this
            Mac. The resulting transcript stays in the project&apos;s disposable
            <code className="mx-1 rounded bg-panel-muted px-1 py-0.5 text-primary">.video</code>
            data and is not a canonical project edit.
          </DialogDescription>
        </DialogHeader>
        <p className="text-ui-xs leading-5 text-muted">
          Cinesim requests Deepgram&apos;s model-improvement opt-out, but this is still a remote
          operation. Cinesim keeps the service credential on the authenticated API and never
          includes full transcript text in diagnostics.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPendingAssetIds(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!userId || !pendingAssetIds) return;
              grantTranscriptionConsent(userId);
              const approved = pendingAssetIds;
              setPendingAssetIds(null);
              void approvedAction.current(approved);
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { request, dialog };
}
