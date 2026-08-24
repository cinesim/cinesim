import { Search } from "lucide-react";
import { forwardRef, type ComponentProps } from "react";
import { cn } from "./cn";

export interface SearchFieldProps extends Omit<ComponentProps<"input">, "size"> {
  size?: "sm" | "md";
  surface?: "panel" | "muted";
  inputClassName?: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, inputClassName, size = "md", surface = "panel", ...props },
  ref,
) {
  return (
    <div
      data-slot="search-field"
      className={cn(
        "flex w-full items-center gap-2 rounded-md border border-border px-2.5 text-muted",
        size === "sm" ? "h-8 px-2 text-ui-xs" : "h-8 text-ui",
        surface === "panel" ? "bg-panel" : "bg-panel-muted",
        className,
      )}
    >
      <Search size={size === "sm" ? 12 : 13} aria-hidden="true" />
      <input
        ref={ref}
        data-slot="search-field-input"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-secondary outline-none placeholder:text-muted",
          size === "sm" && "text-ui-xs",
          inputClassName,
        )}
        type="search"
        {...props}
      />
    </div>
  );
});
