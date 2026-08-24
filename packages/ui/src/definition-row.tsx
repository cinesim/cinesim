import type { ReactNode } from "react";
import { cn } from "./cn";

export interface DefinitionRowProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
  valueClassName?: string;
}

export function DefinitionRow({ label, value, className, valueClassName }: DefinitionRowProps) {
  return (
    <div
      data-slot="definition-row"
      className={cn("flex min-w-0 items-baseline justify-between gap-4 py-1 text-ui-xs", className)}
    >
      <dt data-slot="definition-label" className="truncate text-muted">
        {label}
      </dt>
      <dd
        data-slot="definition-value"
        className={cn("shrink-0 text-right tabular-nums text-secondary", valueClassName)}
      >
        {value}
      </dd>
    </div>
  );
}
