import { LibraryCard, LibraryGrid } from "./library-card";

export function ProjectLoadingState() {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-canvas"
      aria-busy="true"
      aria-label="Loading project"
    >
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <span
          className="h-8 min-w-52 max-w-sm flex-1 animate-pulse rounded-md bg-surface"
          aria-hidden="true"
        />
        <span className="ml-auto h-3 w-12 animate-pulse rounded bg-surface" aria-hidden="true" />
        <span className="h-8 w-28 animate-pulse rounded-md bg-surface-active" aria-hidden="true" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-5 py-6">
        <LibraryGrid>
          {Array.from({ length: 5 }, (_, index) => (
            <LibraryCard
              key={`project-item-loading-${index}`}
              previewClassName="media-thumbnail"
              preview={
                <span className="absolute inset-0 animate-pulse bg-surface" aria-hidden="true" />
              }
            >
              <div className="space-y-2" aria-hidden="true">
                <span className="block h-3.5 w-3/5 animate-pulse rounded bg-surface-active" />
                <span className="block h-3 w-2/5 animate-pulse rounded bg-surface" />
              </div>
            </LibraryCard>
          ))}
        </LibraryGrid>
      </div>
    </section>
  );
}
