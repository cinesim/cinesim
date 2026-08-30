import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { SourceFingerprint } from "../../shared/contracts";

const EDGE_BYTES = 64 * 1024;

export async function fingerprintSource(path: string): Promise<SourceFingerprint> {
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { size: -1, mtimeMs: -1, edgeHash: "missing" };
  const handle = await open(path, "r");
  try {
    const firstSize = Math.min(EDGE_BYTES, info.size);
    const lastSize = Math.min(EDGE_BYTES, Math.max(0, info.size - firstSize));
    const first = Buffer.alloc(firstSize);
    const last = Buffer.alloc(lastSize);
    if (firstSize) await handle.read(first, 0, firstSize, 0);
    if (lastSize) await handle.read(last, 0, lastSize, info.size - lastSize);
    const edgeHash = createHash("sha256").update(first).update(last).digest("hex");
    return { size: info.size, mtimeMs: info.mtimeMs, edgeHash };
  } finally {
    await handle.close();
  }
}

export function fingerprintsEqual(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return (
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.edgeHash === right.edgeHash
  );
}
