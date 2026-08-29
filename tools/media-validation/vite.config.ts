import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@cinesim/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@cinesim/engine": fileURLToPath(
        new URL("../../packages/engine/src/index.ts", import.meta.url),
      ),
    },
  },
  build: {
    target: "chrome142",
    outDir: resolve(workspaceRoot, ".context/media-validation"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
