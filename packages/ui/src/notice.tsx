import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface NoticeProps extends ComponentProps<"div"> {
  size?: "compact" | "default";
}

/** A neutral, inline status message. Callers supply semantic severity when it is genuinely needed. */
export function Notice({ className, size = "compact", ...props }: NoticeProps) {
  return (
    <div
      data-slot="notice"
      className={cn(
        "rounded-md border border-border bg-panel-muted text-secondary",
        size === "compact" ? "px-2.5 py-2 text-ui-xs leading-4" : "px-3 py-2 text-ui",
        className,
      )}
      {...props}
    />
  );
}
