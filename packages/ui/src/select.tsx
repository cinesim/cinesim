import { cva } from "class-variance-authority";
import { forwardRef, type ComponentProps } from "react";
import { cn } from "./cn";

const selectVariants = cva(
  "min-w-0 rounded-md border border-border px-3 text-ui text-primary outline-none focus:border-border-strong focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: { sm: "h-8 px-2.5", md: "h-9" },
      surface: { canvas: "bg-canvas", muted: "bg-panel-muted", panel: "bg-panel" },
    },
    defaultVariants: { size: "md", surface: "canvas" },
  },
);

export interface SelectProps extends Omit<ComponentProps<"select">, "size"> {
  size?: "sm" | "md";
  surface?: "canvas" | "muted" | "panel";
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size, surface, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      data-slot="select"
      className={cn(selectVariants({ size, surface }), className)}
      {...props}
    />
  );
});
