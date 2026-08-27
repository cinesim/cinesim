import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { serverConfig } from "./config";
import { db } from "./db/client";
import * as schema from "./db/schema";
import { sendVerificationEmail } from "./email";

const config = serverConfig();

export const auth = betterAuth({
  appName: "Cinesim",
  baseURL: config.authOrigin,
  secret: config.authSecret,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  trustedOrigins: [config.authOrigin, `${config.desktopScheme}:/`],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ email: user.email, name: user.name, url });
    },
  },
  socialProviders: config.google
    ? {
        google: {
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
          prompt: "select_account",
          requireEmailVerification: true,
        },
      }
    : {},
  rateLimit: {
    enabled: config.environment !== "development" && config.environment !== "test",
    storage: "database",
  },
  advanced: {
    database: { joins: true },
    useSecureCookies: config.environment !== "development" && config.environment !== "test",
  },
  plugins: [electron({ clientID: "cinesim-desktop" })],
});
