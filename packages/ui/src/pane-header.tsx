import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface PaneHeaderProps extends ComponentProps<"div"> {
  size?: "sm" | "md" | "lg";
}

/** A layout-only header for panes and toolbars; it deliberately has no title or action model. */
export function PaneHeader({ className, size = "md", ...props }: PaneHeaderProps) {
  return (
    <div
      data-slot="pane-header"
      className={cn(
        "flex shrink-0 items-center border-b border-border",
        size === "sm" ? "h-10 px-2" : size === "lg" ? "h-14 px-5" : "h-12 px-3",
        className,
      )}
      {...props}
    />
  );
}
