import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const localEnvironmentPath = fileURLToPath(new URL("../.env.local", import.meta.url));
const shouldLoadLocalEnvironment =
  process.env.CINESIM_ENV === undefined || process.env.CINESIM_ENV === "development";
if (shouldLoadLocalEnvironment && existsSync(localEnvironmentPath))
  process.loadEnvFile(localEnvironmentPath);

const environmentSchema = z
  .object({
    CINESIM_ENV: z.enum(["development", "test", "preview", "staging", "production"]),
    CINESIM_API_HOST: z.string().min(1).default("127.0.0.1"),
    CINESIM_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    CINESIM_DESKTOP_SCHEME: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]{2,63}$/i, "must be a valid custom URL scheme"),
    BETTER_AUTH_URL: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname);
    }, "must use HTTPS unless it points to localhost"),
    BETTER_AUTH_SECRET: z.string().min(32),
    DATABASE_URL: z.string().min(1),
    SMTP_URL: z.url(),
    EMAIL_FROM: z.string().min(3),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  })
  .superRefine((value, context) => {
    const hasGoogleId = Boolean(value.GOOGLE_CLIENT_ID);
    const hasGoogleSecret = Boolean(value.GOOGLE_CLIENT_SECRET);
    if (hasGoogleId !== hasGoogleSecret)
      context.addIssue({
        code: "custom",
        path: [hasGoogleId ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"],
        message: "Google OAuth requires both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
      });
    const authUrl = new URL(value.BETTER_AUTH_URL);
    if (
      value.CINESIM_ENV !== "development" &&
      value.CINESIM_ENV !== "test" &&
      authUrl.protocol !== "https:"
    )
      context.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "must use HTTPS outside development and test environments",
      });
  });

export interface ServerConfig {
  environment: z.infer<typeof environmentSchema>["CINESIM_ENV"];
  host: string;
  port: number;
  desktopScheme: string;
  authOrigin: string;
  authSecret: string;
  databaseUrl: string;
  smtpUrl: string;
  emailFrom: string;
  google: { clientId: string; clientSecret: string } | null;
}

let cachedConfig: ServerConfig | null = null;

export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Cinesim API configuration: ${detail}`);
  }
  const value = result.data;
  return {
    environment: value.CINESIM_ENV,
    host: value.CINESIM_API_HOST,
    port: value.CINESIM_API_PORT,
    desktopScheme: value.CINESIM_DESKTOP_SCHEME,
    authOrigin: new URL(value.BETTER_AUTH_URL).origin,
    authSecret: value.BETTER_AUTH_SECRET,
    databaseUrl: value.DATABASE_URL,
    smtpUrl: value.SMTP_URL,
    emailFrom: value.EMAIL_FROM,
    google:
      value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET
        ? { clientId: value.GOOGLE_CLIENT_ID, clientSecret: value.GOOGLE_CLIENT_SECRET }
        : null,
  };
}

export function serverConfig(): ServerConfig {
  cachedConfig ??= readServerConfig(process.env);
  return cachedConfig;
}
