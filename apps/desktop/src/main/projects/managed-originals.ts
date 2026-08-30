import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalProjectRepository } from "@cinesim/project-io";

export async function stageManagedOriginal(input: {
  repository: CanonicalProjectRepository;
  projectDirectory: string;
  sourcePath: string;
  assetId: string;
}): Promise<string> {
  await input.repository.paths.ensureDirectory(".video/originals");
  const managedPath = join(input.projectDirectory, ".video", "originals", input.assetId);
  const temporaryPath = `${managedPath}.${randomUUID()}.tmp`;
  if (await lstat(managedPath).catch(() => null))
    throw new Error("The managed original already exists");
  let published = false;
  try {
    await copyFile(input.sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    const [sourceInfo, copyInfo] = await Promise.all([stat(input.sourcePath), stat(temporaryPath)]);
    if (!sourceInfo.isFile() || !copyInfo.isFile() || sourceInfo.size !== copyInfo.size)
      throw new Error("The managed original copy could not be verified");
    await link(temporaryPath, managedPath);
    published = true;
    await rm(temporaryPath);
    return managedPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (published) await rm(managedPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
