import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export interface TooltipProviderProps extends ComponentProps<typeof BaseTooltip.Provider> {}

export function TooltipProvider({ delay = 400, ...props }: TooltipProviderProps) {
  return <BaseTooltip.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

export function Tooltip({ ...props }: ComponentProps<typeof BaseTooltip.Root>) {
  return <BaseTooltip.Root data-slot="tooltip" {...props} />;
}

export interface TooltipTriggerProps extends Omit<
  ComponentProps<typeof BaseTooltip.Trigger>,
  "className"
> {
  className?: string;
}

export function TooltipTrigger({ className, ...props }: TooltipTriggerProps) {
  return <BaseTooltip.Trigger data-slot="tooltip-trigger" className={className} {...props} />;
}

export interface TooltipContentProps extends Omit<
  ComponentProps<typeof BaseTooltip.Popup>,
  "className"
> {
  className?: string;
  side?: ComponentProps<typeof BaseTooltip.Positioner>["side"];
  sideOffset?: number;
  align?: ComponentProps<typeof BaseTooltip.Positioner>["align"];
  alignOffset?: number;
  children?: ReactNode;
}

export function TooltipContent({
  align = "center",
  alignOffset = 0,
  side = "top",
  sideOffset = 6,
  className,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        data-slot="tooltip-positioner"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="z-[100] isolate"
      >
        <BaseTooltip.Popup
          data-slot="tooltip-content"
          className={cn(
            "max-w-xs rounded-md border border-border-strong bg-panel px-2 py-1 text-ui-xs text-primary shadow-lg shadow-black/20",
            className,
          )}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
