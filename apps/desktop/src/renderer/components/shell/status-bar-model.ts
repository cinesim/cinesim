import type {
  AccountSnapshot,
  CloudTransferSnapshot,
  DerivedMediaSnapshot,
} from "../../../shared/contracts";
import type { ProjectLifecycle } from "../../store/renderer-store";

export type AppStatusTone = "error" | "busy" | "warning";

export interface AppStatus {
  tone: AppStatusTone;
  summary: string;
  title: string;
  detail: string;
  dismissible: boolean;
}

interface AppStatusInput {
  account: AccountSnapshot;
  cloudTransfers: readonly CloudTransferSnapshot[];
  derivedMedia: DerivedMediaSnapshot | null;
  operationError: string | null;
  project: ProjectLifecycle;
}

function projectOperationStatus(project: ProjectLifecycle): AppStatus | null {
  if (project.status === "booting")
    return {
      tone: "busy",
      summary: "Starting Cinesim…",
      title: "Starting Cinesim",
      detail: "Cinesim is loading local project state and checking available services.",
      dismissible: false,
    };
  if (project.status !== "opening") return null;
  const creating = project.operation === "create";
  return {
    tone: "busy",
    summary: creating ? "Creating project…" : "Opening project…",
    title: creating ? "Creating project" : "Opening project",
    detail: creating
      ? "Cinesim is creating the canonical project files and preparing the editor."
      : "Cinesim is validating the project files and preparing the editor.",
    dismissible: false,
  };
}

function failedTransferStatus(transfers: readonly CloudTransferSnapshot[]): AppStatus | null {
  const transfer = transfers.find((candidate) => candidate.state === "failed");
  if (!transfer) return null;
  return {
    tone: "error",
    summary: `Upload failed: ${transfer.name}`,
    title: "Cloud upload failed",
    detail: transfer.error ?? "The original media could not be uploaded.",
    dismissible: false,
  };
}

function activeTransferStatus(transfers: readonly CloudTransferSnapshot[]): AppStatus | null {
  const transfer = transfers.find((candidate) =>
    ["preparing", "uploading", "waiting-for-cloud", "waiting-for-proxy"].includes(candidate.state),
  );
  if (!transfer) return null;
  const percent =
    transfer.bytes > 0 ? Math.round((transfer.uploadedBytes / transfer.bytes) * 100) : 0;
  const uploading = transfer.state === "uploading";
  return {
    tone: "busy",
    summary: uploading ? `Uploading ${transfer.name} · ${percent}%` : `Preparing ${transfer.name}…`,
    title: uploading ? "Uploading original media" : "Preparing cloud media",
    detail: uploading
      ? `${transfer.uploadedBytes.toLocaleString()} of ${transfer.bytes.toLocaleString()} bytes uploaded.`
      : "Cinesim is preparing this asset for its cloud project.",
    dismissible: false,
  };
}

function derivedMediaStatus(derived: DerivedMediaSnapshot | null): AppStatus | null {
  const activeJob = derived?.runtime.activeJob;
  if (!activeJob) return null;
  const stage = activeJob.stage.replaceAll("-", " ");
  return {
    tone: "busy",
    summary: `Preparing media · ${stage} · ${Math.round(activeJob.progress * 100)}%`,
    title: "Preparing derived media",
    detail: `${activeJob.jobKind === "proxy" ? "Proxy" : "Perception"} work is running for ${activeJob.assetId}.`,
    dismissible: false,
  };
}

function sourceDiagnosticStatus(project: ProjectLifecycle): AppStatus | null {
  if (project.status !== "ready" || project.session.diagnostics.length === 0) return null;
  const diagnostics = project.session.diagnostics;
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const tone = errorCount > 0 ? "error" : "warning";
  const label = errorCount > 0 ? "source error" : "source warning";
  const details = diagnostics.map((diagnostic) => {
    const location = diagnostic.source
      ? ` · ${diagnostic.source.uri}:${diagnostic.source.start.line}:${diagnostic.source.start.column}`
      : "";
    return `${diagnostic.code}: ${diagnostic.message}${location}`;
  });
  return {
    tone,
    summary: `${diagnostics.length} ${label}${diagnostics.length === 1 ? "" : "s"}`,
    title: errorCount > 0 ? "Source needs attention" : "Source warning",
    detail: [
      errorCount > 0
        ? "The last valid preview remains active while the project source is invalid."
        : "The project source compiled with diagnostics.",
      ...details,
    ].join("\n\n"),
    dismissible: false,
  };
}

export function appStatus(input: AppStatusInput): AppStatus | null {
  if (input.operationError)
    return {
      tone: "error",
      summary: input.operationError,
      title: "Something needs attention",
      detail: input.operationError,
      dismissible: true,
    };

  return (
    sourceDiagnosticStatus(input.project) ??
    failedTransferStatus(input.cloudTransfers) ??
    projectOperationStatus(input.project) ??
    activeTransferStatus(input.cloudTransfers) ??
    derivedMediaStatus(input.derivedMedia) ??
    (input.account.status === "offline"
      ? {
          tone: "warning",
          summary: "Working offline",
          title: "Working offline",
          detail: input.account.detail ?? "Online account services are currently unavailable.",
          dismissible: false,
        }
      : null)
  );
}
