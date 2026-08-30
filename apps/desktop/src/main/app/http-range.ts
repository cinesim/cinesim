export type ParsedByteRange =
  | { kind: "full"; start: 0; endExclusive: number }
  | { kind: "range"; start: number; endExclusive: number }
  | { kind: "invalid" };

export function parseSingleByteRange(value: string | null, size: number): ParsedByteRange {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "invalid" };
  if (value === null) return { kind: "full", start: 0, endExclusive: size };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return { kind: "invalid" };
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    return { kind: "range", start: Math.max(0, size - suffixLength), endExclusive: size };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  )
    return { kind: "invalid" };
  return { kind: "range", start, endExclusive: Math.min(size, requestedEnd + 1) };
}

export function unsatisfiedRangeResponse(size: number, accessControlOrigin?: string): Response {
  return new Response("Range not satisfiable", {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${size}`,
      ...(accessControlOrigin ? { "Access-Control-Allow-Origin": accessControlOrigin } : {}),
    },
  });
}
