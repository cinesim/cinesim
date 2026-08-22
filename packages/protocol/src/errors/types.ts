export interface ProtocolError {
  code: string;
  message: string;
  details?: unknown;
}

export class ProtocolRequestError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "ProtocolRequestError";
  }
}
