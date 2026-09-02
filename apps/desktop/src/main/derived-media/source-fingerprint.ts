import { projectSourceFingerprintsEqual, sourceFingerprintForPath } from "@cinesim/project-io";
import type { SourceFingerprint } from "../../shared/contracts";

export async function fingerprintSource(path: string): Promise<SourceFingerprint> {
  return sourceFingerprintForPath(path);
}

export function fingerprintsEqual(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return projectSourceFingerprintsEqual(left, right);
}
