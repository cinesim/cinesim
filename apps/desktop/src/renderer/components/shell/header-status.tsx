import { useMemo, useState } from "react";
import {
  Bug,
  CircleAlert,
  LoaderCircle,
  Menu,
  MenuContent,
  MenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@cinesim/ui";
import { toggleAuxiliaryMode } from "../../hooks/use-shell-shortcuts";
import { useRendererStore } from "../../store/renderer-store-context";
import { appStatus, type AppStatus, type AppStatusTone } from "./status-bar-model";

function StatusIcon({ tone }: { tone: AppStatusTone }) {
  if (tone === "error") return <CircleAlert size={12} className="text-red-400" />;
  if (tone === "warning") return <CircleAlert size={12} className="text-amber-500" />;
  return <LoaderCircle size={12} className="animate-spin text-muted" />;
}

function StatusMessage({ status, onDismiss }: { status: AppStatus; onDismiss: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <Menu open={detailsOpen} onOpenChange={setDetailsOpen}>
      <MenuTrigger
        className={cn(
          "h-8 max-w-56 truncate rounded-md px-2 text-ui-xs text-muted outline-none hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-focus",
          status.tone === "error" && "text-red-400",
          status.tone === "warning" && "text-amber-500",
        )}
        aria-label={`${status.title}: ${status.summary}`}
      >
        <span aria-live="polite">{status.summary}</span>
      </MenuTrigger>
      <MenuContent side="bottom" align="end" sideOffset={8} className="w-80 p-3">
        <div className="flex items-center gap-2">
          <StatusIcon tone={status.tone} />
          <p className="text-ui font-semibold text-primary">{status.title}</p>
        </div>
        <p className="mt-1.5 break-words text-ui-xs leading-5 text-muted">{status.detail}</p>
        {status.dismissible && (
          <div className="mt-2 flex justify-end border-t border-border pt-2">
            <button
              type="button"
              className="h-7 rounded-md px-2 text-ui-xs text-secondary hover:bg-surface hover:text-primary"
              onClick={() => {
                onDismiss();
                setDetailsOpen(false);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </MenuContent>
    </Menu>
  );
}

export function HeaderStatus() {
  const project = useRendererStore((state) => state.project);
  const operationError = useRendererStore((state) => state.operationError);
  const derivedMedia = useRendererStore((state) => state.derivedMedia);
  const cloudTransfers = useRendererStore((state) => state.cloudTransfers);
  const account = useRendererStore((state) => state.account);
  const auxiliaryMode = useRendererStore((state) => state.auxiliaryMode);
  const setAuxiliaryMode = useRendererStore((state) => state.setAuxiliaryMode);
  const clearError = useRendererStore((state) => state.clearError);
  const status = useMemo(
    () => appStatus({ account, cloudTransfers, derivedMedia, operationError, project }),
    [account, cloudTransfers, derivedMedia, operationError, project],
  );
  const metricsOpen = auxiliaryMode === "metrics";

  return (
    <>
      {status && <StatusMessage status={status} onDismiss={clearError} />}

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-md text-muted outline-none hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-focus",
                metricsOpen && "bg-surface text-primary",
              )}
              aria-label={metricsOpen ? "Close Metrics sidebar" : "Open Metrics sidebar"}
              aria-pressed={metricsOpen}
              onClick={() => setAuxiliaryMode(toggleAuxiliaryMode(auxiliaryMode, "metrics"))}
            />
          }
        >
          <Bug size={13} />
        </TooltipTrigger>
        <TooltipContent>{metricsOpen ? "Close Metrics" : "Open Metrics"}</TooltipContent>
      </Tooltip>
    </>
  );
}
