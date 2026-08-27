import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { auth } from "./auth";
import { serverConfig } from "./config";
import { db } from "./db/client";
import { LOCAL_DESKTOP_CALLBACK_ORIGIN } from "./local-desktop-callback";
import { authPage } from "./web-page";
import { R2ObjectStore } from "./cloud/r2";
import { CloudStorageService } from "./cloud/service";
import { createCloudRoutes } from "./cloud/routes";

const config = serverConfig();
const app = new Hono();
const cloudStorage = config.r2
  ? new CloudStorageService(new R2ObjectStore(config.r2), config.cloudIncludedBytes)
  : null;

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: [
        "'self'",
        ...(config.environment === "development" ? [LOCAL_DESKTOP_CALLBACK_ORIGIN] : []),
      ],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "no-referrer",
    xFrameOptions: "DENY",
  }),
);

app.use("*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
});

app.get("/", (context) => context.redirect("/sign-in"));
app.get("/sign-in", (context) => context.html(authPage(config)));

app.get("/health", (context) =>
  context.json({
    ok: true,
    environment: config.environment,
    googleSignIn: Boolean(config.google),
    cloudStorage: Boolean(cloudStorage),
  }),
);

app.get("/ready", async (context) => {
  await db.execute(sql`select 1`);
  return context.json({ ok: true });
});

app.get("/api/v1/account", async (context) => {
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "unauthorized" }, 401);
  return context.json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
    },
  });
});

app.route("/api/v1/cloud", createCloudRoutes(cloudStorage));

app.on(["GET", "POST"], "/api/auth/*", (context) => auth.handler(context.req.raw));

app.notFound((context) => context.json({ error: "not_found" }, 404));
app.onError((error, context) => {
  console.error("Cinesim API request failed", error);
  return context.json({ error: "internal_server_error" }, 500);
});

export default app;
