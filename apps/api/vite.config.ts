import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  publicDir: false,
  define: {
    // Better Auth supports Node and browsers from one package. Its browser client still contains
    // environment probes that Vite must resolve at build time instead of leaving a Node global.
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env": "{}",
  },
  build: {
    target: "es2023",
    outDir: resolve(rootDirectory, "public/auth-ui"),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(rootDirectory, "src/web/main.ts"),
      formats: ["es"],
      fileName: () => "auth.js",
      cssFileName: "style",
    },
    rollupOptions: {
      output: { assetFileNames: "[name][extname]" },
    },
  },
});
