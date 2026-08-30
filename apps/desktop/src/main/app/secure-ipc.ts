import { randomUUID } from "node:crypto";
import { app, ipcMain } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { createCinesimLogger } from "@cinesim/logging";
import { ZodError } from "zod";
import type {
  DesktopIpcErrorCode,
  DesktopIpcErrorPayload,
  DesktopIpcResult,
} from "../../shared/contracts/ipc";
import { assertIpcSender } from "./ipc-security";
import type { InvokeContract } from "./ipc-contract";

const trustedRendererIds = new Set<number>();
const registeredChannels = new Set<string>();
const log = createCinesimLogger({ service: "desktop-ipc" });
let developmentUrl: URL | undefined;

export class MainIpcError extends Error {
  constructor(
    readonly code: DesktopIpcErrorCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      details?: DesktopIpcErrorPayload["details"];
    } = {},
  ) {
    super(message);
    this.name = "MainIpcError";
  }
}

export function configureIpcSecurity(input: { developmentUrl: URL | null }): void {
  developmentUrl = input.developmentUrl ?? undefined;
}

export function trustIpcRenderer(webContents: WebContents): void {
  trustedRendererIds.add(webContents.id);
  webContents.once("destroyed", () => trustedRendererIds.delete(webContents.id));
}

export function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  assertIpcSender(event, {
    trustedRendererIds,
    developmentUrl,
    applicationPath: app.getAppPath(),
  });
}

export function registerIpcHandler<TArguments extends unknown[], TResult>(
  contract: InvokeContract<TArguments, TResult>,
  handler: (...arguments_: TArguments) => TResult | Promise<TResult>,
): void {
  if (registeredChannels.has(contract.channel))
    throw new Error(`Duplicate IPC handler registration: ${contract.channel}`);
  registeredChannels.add(contract.channel);
  ipcMain.handle(contract.channel, async (event, ...rawArguments: unknown[]) => {
    const operationId = randomUUID();
    try {
      assertTrustedIpcSender(event);
      const arguments_ = contract.request.parse(rawArguments);
      return {
        ok: true,
        value: await handler(...arguments_),
      } satisfies DesktopIpcResult<TResult>;
    } catch (error) {
      const payload = publicError(error, operationId);
      log.error(
        { err: error, operation: "ipc", channel: contract.channel, operationId },
        "Desktop IPC request failed",
      );
      return { ok: false, error: payload } satisfies DesktopIpcResult<TResult>;
    }
  });
}

function publicError(error: unknown, operationId: string): DesktopIpcErrorPayload {
  if (error instanceof MainIpcError)
    return {
      code: error.code,
      message: error.message,
      operationId,
      ...(error.options.retryable === undefined ? {} : { retryable: error.options.retryable }),
      ...(error.options.details ? { details: error.options.details } : {}),
    };
  if (error instanceof ZodError)
    return { code: "INVALID_REQUEST", message: "The request was invalid", operationId };
  if (error instanceof Error && error.message === "Unauthorized IPC sender")
    return { code: "UNAUTHORIZED", message: "The request was not authorized", operationId };
  return {
    code: "INTERNAL_ERROR",
    message: "The operation could not be completed",
    operationId,
  };
}
