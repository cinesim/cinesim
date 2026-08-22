import { Button as BaseButton } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

const buttonVariants = cva(
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors select-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-violet-500 text-white hover:bg-violet-400",
        secondary: "border border-white/10 bg-white/[0.06] text-zinc-200 hover:bg-white/10",
        ghost: "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100",
        danger: "text-red-300 hover:bg-red-500/15 hover:text-red-200",
      },
      size: {
        sm: "h-7 px-2 text-[11px]",
        md: "h-8 px-2.5",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  className?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <BaseButton className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
