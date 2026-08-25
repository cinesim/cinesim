import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface KbdProps extends ComponentProps<"kbd"> {}

export function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "font-mono text-ui-xs font-bold leading-none tracking-[0.1em] text-muted",
        className,
      )}
      {...props}
    />
  );
}
