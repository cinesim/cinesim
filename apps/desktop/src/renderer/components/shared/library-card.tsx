import type { ComponentProps } from "react";
import { cn } from "@cinesim/ui";

export function LibraryGrid({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("grid grid-cols-[repeat(auto-fill,minmax(240px,280px))] gap-4", className)}
      {...props}
    />
  );
}
