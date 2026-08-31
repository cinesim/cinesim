import type { RecentProject, RecentProjectDetails } from "../../../shared/contracts";

export type ProjectSort = "name" | "modified" | "created" | "size";

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function projectModifiedLabel(timestamp: number | null | undefined, now: number): string {
  if (timestamp === undefined) return "Modified time loading…";
  if (timestamp === null) return "Modified time unavailable";

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  const [amount, unit] =
    elapsedSeconds < 60
      ? [elapsedSeconds, "second"]
      : elapsedSeconds < 3_600
        ? [Math.floor(elapsedSeconds / 60), "minute"]
        : elapsedSeconds < 86_400
          ? [Math.floor(elapsedSeconds / 3_600), "hour"]
          : [Math.floor(elapsedSeconds / 86_400), "day"];

  return `Modified ${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

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
  const field = detailField(sort);
  return projects.toSorted((left, right) => compareProjects(left, right, field, details));
}

function detailField(sort: ProjectSort): keyof RecentProjectDetails | null {
  if (sort === "modified") return "modifiedAt";
  if (sort === "created") return "createdAt";
  if (sort === "size") return "sizeBytes";
  return null;
}

function compareProjects(
  left: RecentProject,
  right: RecentProject,
  field: keyof RecentProjectDetails | null,
  details: Record<string, RecentProjectDetails>,
): number {
  if (!field) return compareNames(left, right);
  const detailOrder = compareDescendingNullable(
    numericDetail(left, details, field),
    numericDetail(right, details, field),
  );
  return detailOrder || compareNames(left, right);
}
