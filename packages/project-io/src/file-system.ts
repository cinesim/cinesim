import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";

export interface ProjectFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
}

export interface ProjectFileSystem {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open(path: string, flags: string): Promise<ProjectFileHandle>;
  readFile: typeof readFile;
  readdir: typeof readdir;
  realpath: typeof realpath;
  rename: typeof rename;
  rm: typeof rm;
  rmdir: typeof rmdir;
  stat: typeof stat;
  writeFile: typeof writeFile;
}

export const nodeProjectFileSystem: ProjectFileSystem = {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
};
