import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./apps/desktop",
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks: {
      "desktop:dev": {
        command: "node apps/desktop/scripts/dev.mjs",
        cache: false,
      },
      "desktop:build": {
        command: [
          "vp build apps/desktop --mode main",
          "vp build apps/desktop --mode preload",
          "vp build apps/desktop --mode renderer",
        ],
      },
      typecheck: {
        command: "tsc --noEmit",
      },
    },
  },
  test: {
    include: [
      "apps/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "tools/**/test/**/*.test.ts",
    ],
    environment: "node",
  },
  check: {
    fmt: true,
    lint: true,
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["pnpm-lock.yaml", "dist/**", ".context/**"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: ["dist/**", ".context/**"],
    plugins: ["eslint", "import", "jsx-a11y", "oxc", "promise", "react", "typescript", "unicorn"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "react-hooks/exhaustive-deps": "error",
      "typescript/no-floating-promises": "error",
    },
  },
});
