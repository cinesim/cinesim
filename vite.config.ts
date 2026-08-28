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
        env: ["CINESIM_CLOUD_ORIGIN"],
      },
      "api:build": {
        command: "vp build --config vite.config.ts",
        cwd: "apps/api",
      },
      "api:setup": {
        command: "vp run --filter @cinesim/api local:setup",
        cache: false,
      },
      "api:migrate": {
        command: "vp run --filter @cinesim/api db:migrate",
        cache: false,
      },
      "api:generate": {
        command: "vp run --filter @cinesim/api db:generate",
        cache: false,
      },
      "web:dev": {
        command: "vp run --filter @cinesim/web dev",
        cache: false,
      },
      "web:start": {
        command: "vp run --filter @cinesim/web start",
        cache: false,
      },
      "web:types": {
        command: "vp run --filter @cinesim/web types:check",
      },
      "web:build": {
        command: "vp run --filter @cinesim/web build",
        env: ["NEXT_PUBLIC_*"],
      },
      "local:dev": {
        command: "node tools/dev-local.mjs",
        cache: false,
      },
      typecheck: {
        command: "tsc --noEmit",
      },
      "verify:fast": {
        command: ["vp check", "vp run typecheck", "vp run web:types", "vp test --run"],
      },
      "build:all": {
        command: ["vp run desktop:build", "vp run api:build", "vp run web:build"],
      },
      verify: {
        command: ["vp run verify:fast", "vp run build:all"],
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
    ignorePatterns: ["dist/**", ".context/**"],
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
