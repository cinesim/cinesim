import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const externals = [
  "electron",
  // Keep Mediabunny external so Electron's Node runtime selects its `node`
  // conditional export, which includes the filesystem-backed FilePathSource.
  "mediabunny",
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
];
const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode === "main") {
    return {
      // Electron main runs in Node. Do not let packages with a `browser` field
      // (for example Pino) resolve to browser shims during bundling.
      resolve: {
        conditions: ["node"],
        mainFields: ["module", "main"],
      },
      build: {
        target: "node22",
        outDir: "dist/main",
        emptyOutDir: false,
        sourcemap: true,
        lib: {
          entry: resolve(rootDirectory, "src/main/index.ts"),
          formats: ["es"],
          fileName: () => "main.js",
        },
        rollupOptions: { external: externals },
      },
    };
  }
  if (mode === "preload") {
    return {
      resolve: {
        conditions: ["node"],
        mainFields: ["module", "main"],
      },
      build: {
        target: "node22",
        outDir: "dist/preload",
        emptyOutDir: false,
        sourcemap: true,
        lib: {
          entry: resolve(rootDirectory, "src/preload/index.ts"),
          formats: ["cjs"],
          fileName: () => "preload.cjs",
        },
        rollupOptions: { external: externals },
      },
    };
  }
  return {
    plugins: [...tailwindcss(), ...react({ compiler: { target: "19" } })],
    resolve: {
      alias: {
        "@renderer": resolve(rootDirectory, "src/renderer"),
      },
    },
    base: "./",
    build: {
      target: "chrome142",
      outDir: "dist/renderer",
      emptyOutDir: false,
      sourcemap: true,
    },
  };
});
