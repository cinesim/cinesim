import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { serverConfig } from "./config";
import { db } from "./db/client";
import * as schema from "./db/schema";
import { sendPasswordResetEmail, sendVerificationEmail } from "./email";

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
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ email: user.email, name: user.name, url });
    },
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
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path !== "/sign-up/email") return;
      const email = context.body?.email;
      if (typeof email !== "string") return;
      const existingUser = await context.context.internalAdapter.findUserByEmail(
        email.toLowerCase(),
      );
      if (!existingUser?.user) return;
      throw APIError.from("UNPROCESSABLE_ENTITY", {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        message: "An account already exists with this email.",
      });
    }),
  },
  advanced: {
    database: { joins: true },
    useSecureCookies: config.environment !== "development" && config.environment !== "test",
  },
  plugins: [electron({ clientID: "cinesim-desktop" })],
});
