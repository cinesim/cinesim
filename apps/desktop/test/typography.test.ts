import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const uiSources = ["apps/desktop/src/renderer", "packages/ui/src"];
const forbiddenTypography = [
  /\bfont-(?:sans|serif|\[[^\]]+\])\b/g,
  /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|\[[^\]]+\])\b/g,
  /\bfont(?:Family|Size)\s*:/g,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:css|ts|tsx)$/.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

describe("renderer typography", () => {
  it("uses Geist, semantic UI sizes, and intentional monospace shortcuts", () => {
    const violations = uiSources.flatMap((directory) =>
      sourceFiles(directory).flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return forbiddenTypography.flatMap((pattern) =>
          Array.from(source.matchAll(pattern), (match) => `${file}: ${match[0]}`),
        );
      }),
    );

    expect(violations).toEqual([]);

    const styles = readFileSync(resolve(root, "apps/desktop/src/renderer/styles.css"), "utf8");
    expect(styles.match(/font-family:\s*[^;]+;/g)).toEqual([
      'font-family: "Geist Variable", sans-serif;',
    ]);
    expect(Array.from(styles.matchAll(/font-size:\s*([^;]+);/g), (match) => match[1])).toEqual([
      "var(--ui-font-size-body)",
      "var(--ui-font-size-compact)",
    ]);
    expect(styles.match(/--ui-font-size-[a-z-]+:\s*\d+px;/g)).toEqual([
      "--ui-font-size-compact: 11px;",
      "--ui-font-size-body: 13px;",
      "--ui-font-size-heading: 20px;",
    ]);
  });
});
