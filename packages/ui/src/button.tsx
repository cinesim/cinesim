import { Button as BaseButton } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

const buttonVariants = cva(
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-ui font-medium outline-none transition-colors select-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover",
        secondary: "border border-border bg-surface text-primary hover:bg-surface-hover",
        ghost: "text-secondary hover:bg-surface hover:text-primary",
        danger: "text-secondary hover:bg-surface-hover hover:text-primary",
      },
      size: {
        sm: "h-7 px-2 text-ui-xs",
        md: "h-8 px-2.5",
        "icon-sm": "size-7 p-0",
        icon: "size-8 p-0",
        "icon-lg": "size-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  className?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon-sm" | "icon" | "icon-lg";
}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <BaseButton
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
