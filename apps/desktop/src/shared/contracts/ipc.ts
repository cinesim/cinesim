export type DesktopIpcErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "USER_CANCELLED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "OPERATION_FAILED"
  | "INTERNAL_ERROR";

export interface DesktopIpcErrorPayload {
  code: DesktopIpcErrorCode;
  message: string;
  operationId: string;
  retryable?: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export type DesktopIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopIpcErrorPayload };

export class DesktopIpcError extends Error {
  readonly code: DesktopIpcErrorCode;
  readonly operationId: string;
  readonly retryable: boolean;
  readonly details: DesktopIpcErrorPayload["details"];

  constructor(payload: DesktopIpcErrorPayload) {
    super(payload.message);
    this.name = "DesktopIpcError";
    this.code = payload.code;
    this.operationId = payload.operationId;
    this.retryable = payload.retryable ?? false;
    this.details = payload.details;
  }
}

export function unwrapDesktopIpcResult<T>(result: DesktopIpcResult<T>): T {
  if (result.ok) return result.value;
  throw new DesktopIpcError(result.error);
}
