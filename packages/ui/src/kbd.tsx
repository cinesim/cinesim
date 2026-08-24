import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface KbdProps extends ComponentProps<"kbd"> {}

export function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "rounded border border-border-strong bg-panel-muted px-1.5 py-0.5 text-[10px] font-medium text-muted shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
