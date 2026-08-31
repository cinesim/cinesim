import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compileVideo,
  parseCompilerConfig,
  type CompilerHost,
  type CompilerSource,
} from "@cinesim/compiler";
import { serializeIr } from "@cinesim/ir";
import { parse } from "smol-toml";

export interface CompileCommandOptions {
  config?: string;
  printIr?: boolean;
  printAst?: boolean;
  explain?: boolean;
  check?: boolean;
}

function revision(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function safeUri(uri: string): string {
  const normalized = path.posix.normalize(uri.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Video source path escapes the configured source directory: ${uri}`);
  }
  return normalized;
}

class DiskCompilerHost implements CompilerHost {
  constructor(private readonly root: string) {}

  private filename(uri: string): string {
    return path.join(this.root, safeUri(uri));
  }

  async read(uri: string): Promise<CompilerSource> {
    const source = await readFile(this.filename(uri), "utf8");
    return { source, revision: revision(source) };
  }

  async resolve(specifier: string, importer: string): Promise<string> {
    if (!specifier.startsWith("."))
      throw new Error(`Only relative imports are supported: ${specifier}`);
    const unresolved = safeUri(path.posix.join(path.posix.dirname(importer), specifier));
    const candidates =
      path.posix.extname(unresolved) === ""
        ? [`${unresolved}.jsx`, `${unresolved}.js`]
        : [unresolved];
    for (const candidate of candidates) {
      try {
        await access(this.filename(candidate));
        return candidate;
      } catch {
        // Try the next supported source extension.
      }
    }
    throw new Error(`Cannot resolve ${specifier} from ${importer}.`);
  }
}

async function configFilename(target: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) return path.resolve(explicit);
  const resolved = path.resolve(target);
  try {
    return (await stat(resolved)).isDirectory() ? path.join(resolved, "cinesim.toml") : resolved;
  } catch {
    throw new Error(`Compiler target does not exist: ${target}`);
  }
}

function writeOutput(value: unknown): void {
  process.stdout.write(typeof value === "string" ? value : serializeIr(value));
}

export async function runCompileCommand(
  target: string,
  options: CompileCommandOptions,
): Promise<void> {
  const filename = await configFilename(target, options.config);
  const configDirectory = path.dirname(filename);
  const config = parseCompilerConfig(parse(await readFile(filename, "utf8")) as unknown);
  const entry = safeUri(config.entry);
  const result = await compileVideo(entry, config, new DiskCompilerHost(configDirectory));

  if (options.printIr) writeOutput(result.ir);
  if (options.printAst) writeOutput({ entry, modules: result.modules });
  if (options.explain) writeOutput({ entry, nodes: result.explanations });

  if (options.check) {
    writeOutput({
      ok: true,
      entry,
      modules: result.modules.length,
      nodes: result.explanations.length,
      diagnostics: result.diagnostics,
    });
    return;
  }

  if (options.printIr || options.printAst || options.explain) return;

  const outputDirectory = path.resolve(configDirectory, config.output);
  await mkdir(outputDirectory, { recursive: true });
  const writes: Array<Promise<void>> = [
    writeFile(path.join(outputDirectory, "scene.ir.json"), serializeIr(result.ir)),
    writeFile(path.join(outputDirectory, "diagnostics.json"), serializeIr(result.diagnostics)),
  ];
  if (config.sourceMaps) {
    writes.push(
      writeFile(path.join(outputDirectory, "scene.ir.map.json"), serializeIr(result.sourceMap)),
    );
  }
  await Promise.all(writes);
  writeOutput({
    ok: true,
    entry,
    output: outputDirectory,
    modules: result.modules.length,
    nodes: result.explanations.length,
    diagnostics: result.diagnostics.length,
  });
}
