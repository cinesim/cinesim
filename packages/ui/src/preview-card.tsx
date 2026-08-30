import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { cn } from "./cn";

export interface PreviewCardProps {
  preview: ReactNode;
  children: ReactNode;
  badge?: string;
  corner?: ReactNode;
  bottomCorner?: ReactNode;
  action?: ReactNode;
  previewClassName?: string;
  previewStyle?: CSSProperties;
  size?: "default" | "compact";
  variant?: "default" | "frameless";
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
}

export function PreviewCard({
  preview,
  children,
  badge,
  corner,
  bottomCorner,
  action,
  previewClassName,
  previewStyle,
  size = "default",
  variant = "default",
  ariaLabel,
  title,
  disabled,
  selected,
  onClick,
  onDoubleClick,
}: PreviewCardProps) {
  const interactive = Boolean(onClick || onDoubleClick);
  const contents = (
    <>
      <div
        data-preview-card-preview
        data-slot="preview-card-preview"
        className={cn(
          "relative grid aspect-video w-full place-items-center overflow-hidden text-muted",
          variant === "default"
            ? "border-b border-border"
            : "rounded-md transition-shadow group-hover:shadow-lg group-hover:shadow-black/10",
          variant === "frameless" && selected && "ring-2 ring-accent/70",
          previewClassName,
        )}
        style={previewStyle}
      >
        {badge && (
          <span className="pointer-events-none absolute left-2 top-2 z-20 rounded bg-panel/85 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-secondary backdrop-blur-sm">
            {badge}
          </span>
        )}
        {corner && (
          <span className="pointer-events-none absolute right-2 top-2 z-20">{corner}</span>
        )}
        {bottomCorner && (
          <span className="pointer-events-none absolute bottom-2 right-2 z-20">{bottomCorner}</span>
        )}
        {preview}
      </div>
      <div
        data-slot="preview-card-body"
        className={cn(
          "relative",
          variant === "frameless"
            ? "pt-2"
            : size === "compact"
              ? "min-h-14 p-2"
              : "min-h-[68px] p-3",
        )}
      >
        {children}
      </div>
    </>
  );

  return (
    <article
      data-slot="preview-card"
      className={cn(
        "group relative min-w-0 text-left transition",
        variant === "default" &&
          "overflow-hidden rounded-md border border-border bg-panel shadow-sm",
        variant === "default" &&
          interactive &&
          "hover:border-border-strong hover:shadow-lg hover:shadow-black/10",
        variant === "default" && selected && "border-accent ring-2 ring-accent/70",
      )}
      data-selected={selected || undefined}
    >
      {interactive ? (
        <button
          type="button"
          className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
          aria-pressed={selected || undefined}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
        >
          {contents}
        </button>
      ) : (
        contents
      )}
      {action && <div className="absolute right-1.5 top-1.5 z-30">{action}</div>}
    </article>
  );
}
