import { useEffect, useState } from "react";
import { sequenceDurationUs, timeUs } from "@cinesim/core";
import type { Sequence } from "@cinesim/core";
import type { ExportJobSnapshot, ExportPreset, ExportPresetId } from "../../../shared/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  HardDriveDownload,
  Input,
  Select,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cinesim/ui";
import { sessionFromLifecycle } from "../../store/renderer-store";
import { useRendererStore } from "../../store/renderer-store-context";
import { formatByteCount, formatDuration } from "../../lib/format";

function activeJob(jobs: readonly ExportJobSnapshot[]): ExportJobSnapshot | undefined {
  return jobs.find(({ state }) => state === "queued" || state === "rendering");
}

function jobStatus(job: ExportJobSnapshot | undefined): string {
  if (!job) return "No export has run in this project session.";
  if (job.state === "completed")
    return `Completed${job.bytes === undefined ? "" : ` · ${formatByteCount(job.bytes)}`}`;
  if (job.state === "failed") return job.detail ?? "Export failed.";
  if (job.state === "canceled") return "Export canceled; no partial file was published.";
  return `Rendering ${Math.round(job.progress * 100)}%`;
}

function rangeUs(value: string, label: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new Error(`${label} must be positive seconds`);
  return Math.round(seconds * 1_000_000);
}

export function ExportControl() {
  const session = useRendererStore((state) => sessionFromLifecycle(state.project));
  const activeSequenceId = useRendererStore((state) => state.activeSequenceId);
  const sequence = session?.project.sequences.find(
    ({ id }) => id === (activeSequenceId ?? session.project.activeSequenceId),
  );
  if (!session || !sequence) return null;
  return (
    <SequenceExportControl key={sequence.id} sequence={sequence} directory={session.directory} />
  );
}

function SequenceExportControl({ sequence, directory }: { sequence: Sequence; directory: string }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetId, setPresetId] = useState<ExportPresetId>("h264-aac-sdr-1080p");
  const [jobs, setJobs] = useState<ExportJobSnapshot[]>([]);
  const [customRange, setCustomRange] = useState(false);
  const [startSeconds, setStartSeconds] = useState("0");
  const [endSeconds, setEndSeconds] = useState(() =>
    (sequenceDurationUs(sequence) / 1_000_000).toFixed(3),
  );
  const [fileName, setFileName] = useState(() => `${sequence.id}.mp4`);
  const [error, setError] = useState<string | null>(null);
  const currentJob = activeJob(jobs) ?? jobs[0];
  const busy = activeJob(jobs);
  const durationUs = sequenceDurationUs(sequence);

  useEffect(() => {
    const unsubscribe = window.cinesim.exports.onChanged(setJobs);
    void Promise.all([window.cinesim.exports.capabilities(), window.cinesim.exports.status()])
      .then(([capabilities, currentJobs]) => {
        setPresets(capabilities.presets);
        setJobs(currentJobs);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Export service is unavailable"),
      );
    return unsubscribe;
  }, [directory]);

  async function startExport(): Promise<void> {
    setError(null);
    try {
      const request = customRange
        ? {
            sequenceId: sequence.id,
            presetId,
            startUs: timeUs(rangeUs(startSeconds, "Range start")),
            endUs: timeUs(rangeUs(endSeconds, "Range end")),
            fileName,
          }
        : { sequenceId: sequence.id, presetId, fileName };
      const job = await window.cinesim.exports.start(request);
      setJobs((current) => [job, ...current.filter(({ id }) => id !== job.id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Export could not start");
    }
  }

  async function cancelExport(): Promise<void> {
    if (!busy) return;
    setError(null);
    try {
      await window.cinesim.exports.cancel(busy.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Export could not be canceled");
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon"
              variant={busy ? "secondary" : "ghost"}
              aria-label={
                busy ? `Exporting ${Math.round(busy.progress * 100)}%` : "Export timeline"
              }
              onClick={() => setOpen(true)}
            />
          }
        >
          <HardDriveDownload size={15} />
        </TooltipTrigger>
        <TooltipContent>
          {busy ? `Exporting ${Math.round(busy.progress * 100)}%` : "Export"}
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Export {sequence.name}</DialogTitle>
            <DialogDescription>
              Render accepted project state through the production compositor to H.264/AAC SDR MP4.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-4">
            <Field>
              <FieldLabel>Preset</FieldLabel>
              <Select
                value={presetId}
                disabled={Boolean(busy)}
                onChange={(event) => setPresetId(event.target.value as ExportPresetId)}
              >
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel>File name</FieldLabel>
              <Input
                value={fileName}
                disabled={Boolean(busy)}
                maxLength={124}
                onChange={(event) => setFileName(event.target.value)}
              />
              <FieldDescription>
                Published atomically under .video/exports. Copy completed deliverables before
                clearing derived data.
              </FieldDescription>
            </Field>
            <label className="flex items-center gap-2 text-ui text-secondary">
              <input
                type="checkbox"
                checked={customRange}
                disabled={Boolean(busy)}
                onChange={(event) => setCustomRange(event.target.checked)}
              />
              Export a custom range instead of the full {formatDuration(durationUs)} timeline
            </label>
            {customRange && (
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Start (seconds)</FieldLabel>
                  <Input
                    type="number"
                    min="0"
                    step="0.001"
                    value={startSeconds}
                    disabled={Boolean(busy)}
                    onChange={(event) => setStartSeconds(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>End (seconds)</FieldLabel>
                  <Input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={endSeconds}
                    disabled={Boolean(busy)}
                    onChange={(event) => setEndSeconds(event.target.value)}
                  />
                </Field>
              </div>
            )}
            <div className="rounded-md border border-border bg-panel-muted p-3 text-ui-xs text-secondary">
              <p>{jobStatus(currentJob)}</p>
              {currentJob?.outputPath && (
                <p className="mt-1 break-all text-muted">{currentJob.outputPath}</p>
              )}
              {error && <p className="mt-1 text-danger">{error}</p>}
            </div>
          </div>
          <DialogFooter className="border-t border-border p-4">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {busy ? (
              <Button variant="danger" onClick={() => void cancelExport()}>
                Cancel export
              </Button>
            ) : (
              <Button
                disabled={!presets.length || !fileName.trim()}
                onClick={() => void startExport()}
              >
                Export MP4
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
