import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface SkeletonProps extends ComponentProps<"span"> {
  tone?: "default" | "active";
}

export function Skeleton({ className, tone = "default", ...props }: SkeletonProps) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded",
        tone === "active" ? "bg-surface-active" : "bg-surface",
        className,
      )}
      {...props}
    />
  );
}
