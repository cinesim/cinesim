import { describe, expect, it } from "vite-plus/test";
import type { RecentProject, RecentProjectDetails } from "../src/shared/contracts";
import {
  projectModifiedLabel,
  sortHomeProjects,
} from "../src/renderer/components/home/home-projects";

const projects: RecentProject[] = [
  { name: "Zebra", directory: "/projects/zebra", kind: "cloud" },
  { name: "alpha 10", directory: "/projects/alpha-10", kind: "local" },
  { name: "Alpha 2", directory: "/projects/alpha-2", kind: "local" },
];

const details: Record<string, RecentProjectDetails> = {
  "/projects/zebra": { sizeBytes: 10, createdAt: 100, modifiedAt: 300 },
  "/projects/alpha-10": { sizeBytes: 30, createdAt: 300, modifiedAt: 100 },
  "/projects/alpha-2": { sizeBytes: 20, createdAt: 200, modifiedAt: 200 },
};

describe("home project sorting", () => {
  it("sorts names naturally and case-insensitively", () => {
    expect(sortHomeProjects(projects, "name", details).map(({ name }) => name)).toEqual([
      "Alpha 2",
      "alpha 10",
      "Zebra",
    ]);
  });

  it("sorts date and size details newest or largest first", () => {
    expect(sortHomeProjects(projects, "modified", details)[0]?.name).toBe("Zebra");
    expect(sortHomeProjects(projects, "created", details)[0]?.name).toBe("alpha 10");
    expect(sortHomeProjects(projects, "size", details)[0]?.name).toBe("alpha 10");
  });

  it("keeps unavailable details last and uses names as a stable fallback", () => {
    expect(
      sortHomeProjects(projects, "size", {
        "/projects/zebra": details["/projects/zebra"]!,
      }).map(({ name }) => name),
    ).toEqual(["Zebra", "Alpha 2", "alpha 10"]);
  });
});

describe("home project modified labels", () => {
  const now = 1_800_000_000;

  it.each([
    [now - 42_000, "Modified 42 seconds ago"],
    [now - 2 * 60_000, "Modified 2 minutes ago"],
    [now - 3 * 3_600_000, "Modified 3 hours ago"],
    [now - 4 * 86_400_000, "Modified 4 days ago"],
  ])("formats elapsed time by its largest useful unit", (timestamp, label) => {
    expect(projectModifiedLabel(timestamp, now)).toBe(label);
  });

  it("reports loading and unavailable timestamps", () => {
    expect(projectModifiedLabel(undefined, now)).toBe("Modified time loading…");
    expect(projectModifiedLabel(null, now)).toBe("Modified time unavailable");
  });
});
