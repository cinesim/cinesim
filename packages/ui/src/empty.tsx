import type { ComponentProps } from "react";
import { cn } from "./cn";

export function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center text-center",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("max-w-sm", className)} {...props} />;
}

export function EmptyIcon({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-icon"
      className={cn("mx-auto flex items-center justify-center text-disabled", className)}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="empty-title" className={cn("text-ui text-muted", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-description"
      className={cn("mt-1 text-ui-xs text-muted", className)}
      {...props}
    />
  );
}

export function EmptyActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty-actions" className={cn("mt-4", className)} {...props} />;
}
