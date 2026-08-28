# Local authentication

Cinesim authentication is optional and does not participate in canonical project editing. The
desktop remains fully usable in local mode when the API, database, or network is unavailable.
Local projects are device-wide and can be created, opened, edited, and used with local agents while
signed out. Authentication is requested only when the user creates or opens a cloud project, views
cloud storage, or performs another cloud-only action.

## Components

- Hono serves the Better Auth API, the browser sign-in page, and authenticated Cinesim routes.
- PostgreSQL stores users, linked provider accounts, sessions, verification tokens, and rate limits.
- Mailpit captures verification email during local development.
- Electron main owns the Better Auth client and encrypted session cookie. The renderer receives a
  sanitized account snapshot through narrow IPC.

`packages/core` does not depend on any authentication or database package.

## First local setup

Docker Desktop must be running. Then execute:

```bash
pnpm auth:setup
```

This command:

1. Creates ignored `apps/api/.env.local` from `.env.example` with a random Better Auth secret, or
   backfills settings added to the example without changing existing secrets or values.
2. Starts pinned PostgreSQL and Mailpit containers.
3. Waits for PostgreSQL readiness.
4. Applies the committed Drizzle migrations.

It does not launch Electron. The local services persist their data in named Docker volumes.

The generated environment includes optional Cloudflare R2 settings. Cloud storage remains disabled
until the account ID, bucket, access key ID, and secret access key are all filled in.

Start the complete development environment with:

```bash
pnpm dev:local
```

That starts the local dependencies, watches the auth browser bundle and Hono API, waits for the API
readiness check, and finally starts the existing desktop development process.

Useful local addresses:

| Service               | Address                 |
| --------------------- | ----------------------- |
| Hono API and sign-in  | `http://127.0.0.1:8787` |
| Desktop auth callback | `http://127.0.0.1:8788` |
| Mailpit inbox         | `http://127.0.0.1:8025` |
| PostgreSQL            | `127.0.0.1:54329`       |

Stop the containers without deleting their data:

```bash
pnpm auth:down
```

## Email verification

Email/password registration requires a name, valid email, and password of at least ten characters.
Better Auth sends a one-hour verification link through local SMTP. Open Mailpit, select the message,
and follow its link in the same system browser. Better Auth verifies the address, creates the session,
and returns a short-lived PKCE-bound authorization code to the desktop app.

Passwords and verification tokens never enter the Electron renderer.

## Password recovery

The browser sign-in page exposes a **Forgot password?** flow for email-password accounts. Better
Auth creates a one-hour, single-use reset token and sends the reset link through the configured SMTP
transport. During local development, open Mailpit at `http://127.0.0.1:8025`, select the password
reset message, and follow its link to choose a new password. Completing a reset revokes the user's
existing sessions.

For accounts originally created with Google, password recovery can add an email-password credential
after ownership of the address is proven through the reset email. Google sign-in continues to work.

### Development callback

Electron custom URL schemes on macOS and Linux require a packaged application. During development,
Electron main therefore listens only on `127.0.0.1:8788` while the app is running. The browser sends
the short-lived one-time authorization code to that listener, and Electron exchanges it with Better
Auth using the PKCE verifier that never left the main process. The listener accepts only the exact
local Hono origin and is not enabled in packaged builds.

Packaged desktop builds continue to use `build.cinesim.desktop://auth/callback`, declared in the
application bundle. This keeps local development reliable without changing the production flow.

## Google sign-in

Create a separate nonproduction OAuth client in Google Cloud:

1. Configure the Google Auth Platform consent screen and add your Google account as a test user.
2. Create an OAuth client with application type **Web application**.
3. Add this exact authorized redirect URI:

   ```text
   http://127.0.0.1:8787/api/auth/callback/google
   ```

4. Add this authorized JavaScript origin if the console requests one:

   ```text
   http://127.0.0.1:8787
   ```

5. Put the values in the ignored `apps/api/.env.local` file:

   ```text
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

6. Restart the local API.

The callback must match exactly, including `http`, `127.0.0.1`, port, and path. Google permits HTTP
for localhost IP addresses, but production callbacks must use HTTPS. Only the standard `openid`,
`email`, and `profile` identity scopes are requested by Better Auth.

The Google client secret belongs only in the Hono server environment. It is never bundled into the
browser sign-in JavaScript or desktop application.

## Schema changes

Better Auth `1.7.2` generated the initial Drizzle schema. When upgrading Better Auth or changing its
plugins:

1. Run the matching Better Auth schema generator against `apps/api/src/auth.ts`.
2. Review the generated `apps/api/src/db/schema.ts` changes.
3. Run `pnpm --filter @cinesim/api db:generate`.
4. Review and commit the SQL migration and Drizzle metadata.
5. Apply it locally with `pnpm auth:setup`.

Do not run schema migration from a server request or application startup. Committed migrations are
the single schema history for local PostgreSQL, PlanetScale preview branches, staging, and production.

## Production mapping

The local implementation maps directly to a deployed environment:

| Local                       | Production                                      |
| --------------------------- | ----------------------------------------------- |
| Docker PostgreSQL URL       | PlanetScale pooled runtime URL on port 6432     |
| Local migration URL         | PlanetScale direct migration URL on port 5432   |
| Mailpit SMTP                | Production transactional-email SMTP credentials |
| `http://127.0.0.1:8787`     | Canonical HTTPS API origin                      |
| `build.cinesim.dev`         | `build.cinesim.desktop`                         |
| Nonproduction Google client | Separate production Google client               |

Production builds set the public `CINESIM_CLOUD_ORIGIN` during the desktop main-process build. All
server secrets remain deployment environment variables. CI and Vercel provisioning are intentionally
not configured yet.

Before public production login, add the final homepage, privacy policy, terms, production email
sender, abuse controls such as Turnstile, and Google OAuth publication/verification as applicable.
