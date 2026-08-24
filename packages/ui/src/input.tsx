import { cva } from "class-variance-authority";
import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "./cn";

const inputVariants = cva(
  "min-w-0 rounded-md border border-border px-3 text-ui text-primary outline-none placeholder:text-disabled focus:border-border-strong focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: { sm: "h-8 px-2.5", md: "h-9" },
      surface: { canvas: "bg-canvas", muted: "bg-panel-muted", panel: "bg-panel" },
    },
    defaultVariants: { size: "md", surface: "canvas" },
  },
);

export interface InputProps extends Omit<ComponentProps<typeof BaseInput>, "className" | "size"> {
  className?: string;
  size?: "sm" | "md";
  surface?: "canvas" | "muted" | "panel";
}

export function Input({ className, size, surface, ...props }: InputProps) {
  return (
    <BaseInput
      data-slot="input"
      className={cn(inputVariants({ size, surface }), className)}
      {...props}
    />
  );
}
