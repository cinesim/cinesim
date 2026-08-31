import { applyCommand, CommandError } from "@cinesim/core";
import type { CommandResult, Project } from "@cinesim/core";
import { ZodError } from "zod";
import { legacyEditorCommandSchema } from "./schema";
import type { ProtocolError } from "../errors/types";

export type DispatchResult =
  | { ok: true; value: CommandResult }
  | { ok: false; error: ProtocolError };

export function dispatchCommand(project: Project, input: unknown): DispatchResult {
  try {
    const command = legacyEditorCommandSchema.parse(input);
    return { ok: true, value: applyCommand(project, command) };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        ok: false,
        error: {
          code: "INVALID_COMMAND",
          message: "Command did not match the protocol schema",
          details: error.issues,
        },
      };
    }
    if (error instanceof CommandError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return {
      ok: false,
      error: {
        code: "COMMAND_FAILED",
        message: error instanceof Error ? error.message : "Unknown command failure",
      },
    };
  }
}
