import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, githubUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: "/",
    },
    githubUrl,
    // The site is dark only, so there is nothing to switch between.
    themeSwitch: { enabled: false },
    links: [
      { text: "Product", url: "/#product", active: "none" },
      { text: "Pricing", url: "/pricing", active: "none" },
    ],
  };
}
