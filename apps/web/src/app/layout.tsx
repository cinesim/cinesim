import "@fontsource-variable/geist/wght.css";
import "./globals.css";

import type { Metadata, Viewport } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { appDescription, appName } from "@/lib/shared";

export const metadata: Metadata = {
  title: {
    default: `${appName} — Edit with intent`,
    template: `${appName} — %s`,
  },
  description: appDescription,
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The site is dark only, exactly as the design tokens describe it.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
