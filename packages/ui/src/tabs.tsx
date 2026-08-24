import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface TabsProps extends Omit<ComponentProps<typeof BaseTabs.Root>, "className"> {
  className?: string;
}

export function Tabs({ className, ...props }: TabsProps) {
  return (
    <BaseTabs.Root data-slot="tabs" className={cn("flex min-h-0 flex-col", className)} {...props} />
  );
}

export interface TabsListProps extends Omit<ComponentProps<typeof BaseTabs.List>, "className"> {
  className?: string;
}

export function TabsList({ className, ...props }: TabsListProps) {
  return (
    <BaseTabs.List
      data-slot="tabs-list"
      className={cn("flex border-b border-border", className)}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends Omit<ComponentProps<typeof BaseTabs.Tab>, "className"> {
  className?: string;
}

export function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <BaseTabs.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative flex h-10 items-center justify-center gap-2 px-3 text-ui text-secondary outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-focus data-active:text-primary data-active:after:absolute data-active:after:inset-x-2 data-active:after:bottom-[-1px] data-active:after:h-px data-active:after:bg-primary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsContentProps extends Omit<ComponentProps<typeof BaseTabs.Panel>, "className"> {
  className?: string;
}

export function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <BaseTabs.Panel
      data-slot="tabs-content"
      className={cn("min-h-0 outline-none", className)}
      {...props}
    />
  );
}
