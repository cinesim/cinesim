import { cn } from "@cinesim/ui";

interface LibraryCardProps {
  preview: React.ReactNode;
  children: React.ReactNode;
  badge?: string;
  corner?: React.ReactNode;
  bottomCorner?: React.ReactNode;
  previewClassName?: string;
  previewStyle?: React.CSSProperties;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

export function LibraryCard({
  preview,
  children,
  badge,
  corner,
  bottomCorner,
  previewClassName,
  previewStyle,
  ariaLabel,
  title,
  disabled,
  onClick,
  onDoubleClick,
}: LibraryCardProps) {
  const interactive = Boolean(onClick || onDoubleClick);

  return (
    <article
      className={cn(
        "group relative min-w-0 overflow-hidden rounded-xl border border-border bg-panel text-left shadow-sm transition",
        interactive &&
          "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg hover:shadow-black/10",
      )}
    >
      {interactive && (
        <button
          type="button"
          className="absolute inset-0 z-40 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
        />
      )}
      <div
        className={cn(
          "relative grid aspect-video w-full place-items-center overflow-hidden border-b border-border text-muted",
          previewClassName,
        )}
        style={previewStyle}
      >
        {badge && (
          <span className="absolute left-2 top-2 rounded bg-panel/85 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-secondary backdrop-blur-sm">
            {badge}
          </span>
        )}
        {corner && <span className="absolute right-2 top-2">{corner}</span>}
        {bottomCorner && <span className="absolute bottom-2 right-2">{bottomCorner}</span>}
        {preview}
      </div>
      <div className="relative z-30 min-h-[68px] p-3">{children}</div>
    </article>
  );
}

export function LibraryGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,280px))] gap-4">{children}</div>
  );
}
