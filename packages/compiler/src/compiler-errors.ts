import type { IrDiagnostic, SourceSpan } from "@cinesim/ir";

export class CompilerError extends Error {
  readonly diagnostic: IrDiagnostic;

  constructor(diagnostic: IrDiagnostic) {
    const location =
      diagnostic.source === undefined
        ? ""
        : `${diagnostic.source.uri}:${diagnostic.source.start.line}:${diagnostic.source.start.column} `;
    super(`${location}[${diagnostic.code}] ${diagnostic.message}`);
    this.name = "CompilerError";
    this.diagnostic = diagnostic;
  }
}

export function fail(code: string, message: string, source?: SourceSpan): never {
  throw new CompilerError({
    severity: "error",
    code,
    message,
    ...(source === undefined ? {} : { source }),
  });
}
