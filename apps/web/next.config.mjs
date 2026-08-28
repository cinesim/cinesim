import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Content lives outside this app, in the repository's `docs/` folder.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  turbopack: {
    root: new URL("../../", import.meta.url).pathname,
  },
};

export default withMDX(config);
