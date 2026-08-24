import { PaneHeader, PreviewCard, Skeleton } from "@cinesim/ui";
import { LibraryGrid } from "./library-card";

export function ProjectLoadingState() {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-canvas"
      aria-busy="true"
      aria-label="Loading project"
    >
      <PaneHeader size="lg" className="gap-3">
        <Skeleton className="h-8 min-w-52 max-w-sm flex-1 rounded-md" />
        <Skeleton className="ml-auto h-3 w-12" />
        <Skeleton className="h-8 w-28 rounded-md" tone="active" />
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-hidden px-5 py-6">
        <LibraryGrid>
          {Array.from({ length: 5 }, (_, index) => (
            <PreviewCard
              key={`project-item-loading-${index}`}
              previewClassName="media-thumbnail"
              preview={<Skeleton className="absolute inset-0 rounded-none" />}
            >
              <div className="space-y-2" aria-hidden="true">
                <Skeleton className="block h-3.5 w-3/5" tone="active" />
                <Skeleton className="block h-3 w-2/5" />
              </div>
            </PreviewCard>
          ))}
        </LibraryGrid>
      </div>
    </section>
  );
}
