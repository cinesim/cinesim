import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { cloudProject } from "../db/schema";

export class ProjectRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 403 | 404 = 404,
  ) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

function projectId(): string {
  return `cloud_project_${randomUUID().replaceAll("-", "")}`;
}

function projectSnapshot(project: typeof cloudProject.$inferSelect) {
  return {
    id: project.id,
    clientProjectId: project.clientProjectId,
    name: project.name,
  };
}

export class ProjectRegistryService {
  async list(userId: string) {
    const projects = await db
      .select()
      .from(cloudProject)
      .where(eq(cloudProject.userId, userId))
      .orderBy(cloudProject.name, cloudProject.id);
    return projects.map(projectSnapshot);
  }

  async ensure(
    userId: string,
    input: { cloudProjectId?: string | undefined; clientProjectId: string; name: string },
  ) {
    if (input.cloudProjectId) {
      const project = await this.require(userId, input.cloudProjectId);
      if (project.clientProjectId !== input.clientProjectId)
        throw new ProjectRegistryError(
          "PROJECT_ID_MISMATCH",
          "The local project does not match its account registration",
          403,
        );
      if (project.name !== input.name) {
        const [updated] = await db
          .update(cloudProject)
          .set({ name: input.name })
          .where(eq(cloudProject.id, project.id))
          .returning();
        return projectSnapshot(updated!);
      }
      return projectSnapshot(project);
    }

    const [project] = await db
      .insert(cloudProject)
      .values({ id: projectId(), userId, clientProjectId: input.clientProjectId, name: input.name })
      .onConflictDoUpdate({
        target: [cloudProject.userId, cloudProject.clientProjectId],
        set: { name: input.name },
      })
      .returning();
    if (!project) throw new Error("Project registration could not be created");
    return projectSnapshot(project);
  }

  async require(userId: string, id: string) {
    const [project] = await db
      .select()
      .from(cloudProject)
      .where(and(eq(cloudProject.id, id), eq(cloudProject.userId, userId)))
      .limit(1);
    if (!project)
      throw new ProjectRegistryError(
        "PROJECT_NOT_FOUND",
        "The project is unavailable for this account",
      );
    return project;
  }
}
