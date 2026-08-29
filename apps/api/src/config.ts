import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const localEnvironmentPath = fileURLToPath(new URL("../.env.local", import.meta.url));
const shouldLoadLocalEnvironment =
  process.env.CINESIM_ENV === undefined || process.env.CINESIM_ENV === "development";
if (shouldLoadLocalEnvironment && existsSync(localEnvironmentPath))
  process.loadEnvFile(localEnvironmentPath);

const optionalEnvironmentValue = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

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
    DEEPGRAM_API_KEY: optionalEnvironmentValue,
    OPENROUTER_API_KEY: optionalEnvironmentValue,
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    CLOUDFLARE_R2_ACCOUNT_ID: optionalEnvironmentValue,
    CLOUDFLARE_R2_BUCKET: optionalEnvironmentValue,
    CLOUDFLARE_R2_ACCESS_KEY_ID: optionalEnvironmentValue,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: optionalEnvironmentValue,
    CINESIM_CLOUD_INCLUDED_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .safe()
      .default(10 * 1024 ** 3),
    CINESIM_CLOUD_ADDON_OPTIONS_BYTES: z
      .string()
      .default("0")
      .transform((source, context) => {
        const values = source.split(",").map((part) => Number(part.trim()));
        if (
          values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 5 * 1024 ** 4)
        ) {
          context.addIssue({ code: "custom", message: "must be comma-separated byte counts" });
          return z.NEVER;
        }
        return [...new Set([0, ...values])].sort((left, right) => left - right);
      }),
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
    const r2Values = [
      value.CLOUDFLARE_R2_ACCOUNT_ID,
      value.CLOUDFLARE_R2_BUCKET,
      value.CLOUDFLARE_R2_ACCESS_KEY_ID,
      value.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    ];
    if (r2Values.some(Boolean) && !r2Values.every(Boolean))
      context.addIssue({
        code: "custom",
        path: ["CLOUDFLARE_R2_ACCOUNT_ID"],
        message: "R2 storage requires account ID, bucket, access key ID, and secret access key",
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
  deepgramApiKey: string | null;
  openRouterApiKey: string | null;
  google: { clientId: string; clientSecret: string } | null;
  r2: {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  } | null;
  cloudIncludedBytes: number;
  cloudAddonOptionsBytes: number[];
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
    deepgramApiKey: value.DEEPGRAM_API_KEY ?? null,
    openRouterApiKey: value.OPENROUTER_API_KEY ?? null,
    google:
      value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET
        ? { clientId: value.GOOGLE_CLIENT_ID, clientSecret: value.GOOGLE_CLIENT_SECRET }
        : null,
    r2:
      value.CLOUDFLARE_R2_ACCOUNT_ID &&
      value.CLOUDFLARE_R2_BUCKET &&
      value.CLOUDFLARE_R2_ACCESS_KEY_ID &&
      value.CLOUDFLARE_R2_SECRET_ACCESS_KEY
        ? {
            accountId: value.CLOUDFLARE_R2_ACCOUNT_ID,
            bucket: value.CLOUDFLARE_R2_BUCKET,
            accessKeyId: value.CLOUDFLARE_R2_ACCESS_KEY_ID,
            secretAccessKey: value.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
          }
        : null,
    cloudIncludedBytes: value.CINESIM_CLOUD_INCLUDED_BYTES,
    cloudAddonOptionsBytes: value.CINESIM_CLOUD_ADDON_OPTIONS_BYTES,
  };
}

export function serverConfig(): ServerConfig {
  cachedConfig ??= readServerConfig(process.env);
  return cachedConfig;
}
