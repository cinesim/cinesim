import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth";
import { ProjectRegistryError, type ProjectRegistryService } from "./service";

const cloudProjectId = z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
const projectInput = z.object({
  cloudProjectId: cloudProjectId.optional(),
  clientProjectId: z.string().regex(/^project_[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  name: z.string().trim().min(1).max(120),
});

export function createProjectRoutes(service: ProjectRegistryService) {
  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.use("*", async (context, next) => {
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session) return context.json({ error: "unauthorized" }, 401);
    context.set("userId", session.user.id);
    await next();
  });

  routes.get("/", async (context) => context.json(await service.list(context.get("userId"))));
  routes.post("/", async (context) => {
    const input = projectInput.parse(await context.req.json());
    return context.json(await service.ensure(context.get("userId"), input));
  });
  routes.get("/:cloudProjectId", async (context) => {
    const id = cloudProjectId.parse(context.req.param("cloudProjectId"));
    const project = await service.require(context.get("userId"), id);
    return context.json({
      id: project.id,
      clientProjectId: project.clientProjectId,
      name: project.name,
    });
  });

  routes.onError((error, context) => {
    if (error instanceof ProjectRegistryError)
      return context.json({ error: error.code, message: error.message }, error.status);
    if (error instanceof z.ZodError)
      return context.json({ error: "invalid_request", issues: error.issues }, 400);
    throw error;
  });
  return routes;
}
