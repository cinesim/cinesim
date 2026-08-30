import type { RecentProject, RecentProjectDetails } from "../../../shared/contracts";

export type ProjectSort = "name" | "modified" | "created" | "size";

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNames(left: RecentProject, right: RecentProject): number {
  return (
    nameCollator.compare(left.name, right.name) ||
    nameCollator.compare(left.directory, right.directory)
  );
}

function numericDetail(
  project: RecentProject,
  details: Record<string, RecentProjectDetails>,
  field: keyof RecentProjectDetails,
): number | null {
  return details[project.directory]?.[field] ?? null;
}

function compareDescendingNullable(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return right - left;
}

export function sortHomeProjects(
  projects: readonly RecentProject[],
  sort: ProjectSort,
  details: Record<string, RecentProjectDetails>,
): RecentProject[] {
  return projects.toSorted((left, right) => {
    const detailOrder =
      sort === "name"
        ? 0
        : compareDescendingNullable(
            numericDetail(
              left,
              details,
              sort === "modified" ? "modifiedAt" : sort === "created" ? "createdAt" : "sizeBytes",
            ),
            numericDetail(
              right,
              details,
              sort === "modified" ? "modifiedAt" : sort === "created" ? "createdAt" : "sizeBytes",
            ),
          );
    return detailOrder || compareNames(left, right);
  });
}
