import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function Menu({ ...props }: ComponentProps<typeof BaseMenu.Root>) {
  return <BaseMenu.Root data-slot="menu" {...props} />;
}

export interface MenuTriggerProps extends Omit<
  ComponentProps<typeof BaseMenu.Trigger>,
  "className"
> {
  className?: string;
}

export function MenuTrigger({ className, ...props }: MenuTriggerProps) {
  return (
    <BaseMenu.Trigger
      data-slot="menu-trigger"
      className={cn("outline-none focus-visible:ring-2 focus-visible:ring-focus", className)}
      {...props}
    />
  );
}

export interface MenuContentProps extends Omit<ComponentProps<typeof BaseMenu.Popup>, "className"> {
  className?: string;
  side?: ComponentProps<typeof BaseMenu.Positioner>["side"];
  sideOffset?: number;
  align?: ComponentProps<typeof BaseMenu.Positioner>["align"];
  alignOffset?: number;
  positionerClassName?: string;
  children?: ReactNode;
}

export function MenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  className,
  positionerClassName,
  children,
  ...props
}: MenuContentProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        data-slot="menu-positioner"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className={cn("z-[80] isolate outline-none", positionerClassName)}
      >
        <BaseMenu.Popup
          data-slot="menu-content"
          className={cn(
            "origin-[var(--transform-origin)] max-h-[var(--available-height)] overflow-x-hidden overflow-y-auto rounded-xl border border-border-strong bg-panel p-1.5 text-primary shadow-2xl shadow-black/30 outline-none transition-[transform,opacity] duration-100 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export interface MenuItemProps extends Omit<ComponentProps<typeof BaseMenu.Item>, "className"> {
  className?: string;
}

export function MenuItem({ className, ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item
      data-slot="menu-item"
      className={cn(
        "group flex min-h-10 cursor-default items-center gap-2 rounded-lg px-2.5 text-left outline-none data-[highlighted]:bg-surface data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export interface MenuLabelProps extends Omit<
  ComponentProps<typeof BaseMenu.GroupLabel>,
  "className"
> {
  className?: string;
}

export function MenuLabel({ className, ...props }: MenuLabelProps) {
  return (
    <BaseMenu.GroupLabel
      data-slot="menu-label"
      className={cn("px-2 py-1.5 text-ui-xs font-medium text-muted", className)}
      {...props}
    />
  );
}

export interface MenuSeparatorProps extends Omit<
  ComponentProps<typeof BaseMenu.Separator>,
  "className"
> {
  className?: string;
}

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <BaseMenu.Separator
      data-slot="menu-separator"
      className={cn("my-1.5 h-px bg-border", className)}
      {...props}
    />
  );
}
