import { useEffect, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Grid3X3, ListTree, cn } from "@cinesim/ui";

export type LibraryView = "grid" | "list";

export function useLibraryView(
  storageKey: string,
): readonly [LibraryView, (view: LibraryView) => void] {
  const [view, setView] = useState<LibraryView>(() =>
    localStorage.getItem(storageKey) === "list" ? "list" : "grid",
  );

  useEffect(() => localStorage.setItem(storageKey, view), [storageKey, view]);

  return [view, setView] as const;
}

export function LibraryViewToggle({
  label,
  view,
  onViewChange,
}: {
  label: string;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
}) {
  return (
    <fieldset className="flex overflow-hidden rounded-md border border-border bg-panel">
      <legend className="sr-only">{label}</legend>
      <button
        type="button"
        className={cn(
          "grid size-8 place-items-center border-r border-border text-muted outline-none hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
          view === "grid" && "bg-surface text-primary",
        )}
        aria-label="Grid view"
        aria-pressed={view === "grid"}
        title="Grid view"
        onClick={() => onViewChange("grid")}
      >
        <Grid3X3 size={15} />
      </button>
      <button
        type="button"
        className={cn(
          "grid size-8 place-items-center text-muted outline-none hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
          view === "list" && "bg-surface text-primary",
        )}
        aria-label="List view"
        aria-pressed={view === "list"}
        title="List view"
        onClick={() => onViewChange("list")}
      >
        <ListTree size={15} />
      </button>
    </fieldset>
  );
}

export function LibraryToolbar({
  title,
  count,
  search,
  children,
}: {
  title: ReactNode;
  count?: ReactNode;
  search?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 px-5">
      <div className="flex shrink-0 items-baseline gap-2">
        <h1 className="text-ui font-semibold text-primary">{title}</h1>
        {count !== undefined && <span className="text-ui-xs tabular-nums text-muted">{count}</span>}
      </div>
      {search}
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function LibraryGrid({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("grid grid-cols-[repeat(auto-fill,minmax(240px,280px))] gap-4", className)}
      {...props}
    />
  );
}

export function LibraryList({
  columnsClassName,
  minWidthClassName,
  headers,
  children,
}: {
  columnsClassName: string;
  minWidthClassName: string;
  headers: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <div className={cn("grid bg-panel-muted", columnsClassName, minWidthClassName)}>
        {headers.map((label) => (
          <div
            key={label}
            className="px-3 py-2 text-ui-xs font-semibold uppercase tracking-[0.08em] text-muted"
          >
            {label}
          </div>
        ))}
      </div>
      <div className={minWidthClassName}>{children}</div>
    </div>
  );
}

export function LibraryListRow({
  columnsClassName,
  selected = false,
  className,
  ...props
}: ComponentProps<"button"> & {
  columnsClassName: string;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "grid w-full items-center text-left text-ui text-secondary outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-50",
        selected && "bg-selection",
        columnsClassName,
        className,
      )}
      aria-pressed={selected || undefined}
      {...props}
    />
  );
}
