import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export interface SectionHeadingProps extends ComponentProps<"h3"> {
  icon?: ReactNode;
}

export function SectionHeading({ children, className, icon, ...props }: SectionHeadingProps) {
  return (
    <h3
      data-slot="section-heading"
      className={cn(
        "flex items-center gap-2 text-ui-xs font-semibold uppercase tracking-[0.12em] text-muted",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </h3>
  );
}
