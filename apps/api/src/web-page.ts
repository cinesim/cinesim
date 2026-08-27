import type { ServerConfig } from "./config";
import { LOCAL_DESKTOP_CALLBACK_URL } from "./local-desktop-callback";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function authPage(config: ServerConfig): string {
  const scheme = escapeAttribute(config.desktopScheme);
  const localCallback = config.environment === "development" ? LOCAL_DESKTOP_CALLBACK_URL : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="cinesim-desktop-scheme" content="${scheme}" />
    <meta name="cinesim-local-callback" content="${localCallback}" />
    <meta name="cinesim-google-enabled" content="${String(Boolean(config.google))}" />
    <meta name="theme-color" content="#111111" />
    <title>Sign in to Cinesim</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23fff'/%3E%3Cpath d='M21.5 10.7a8 8 0 1 0 0 10.6l-2.3-2.1a5 5 0 1 1 0-6.4z' fill='%23111'/%3E%3C/svg%3E" />
    <link rel="stylesheet" href="/auth-ui/style.css" />
  </head>
  <body>
    <main class="auth-shell">
      <div class="auth-stack">
        <section class="auth-card" aria-label="Cinesim authentication">
          <div id="authenticated" class="auth-state" aria-labelledby="authenticated-title" hidden>
            <div class="success-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                <path d="m6.75 12.25 3.5 3.5 7-8" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1 id="authenticated-title">You’re signed in</h1>
            <p id="return-status">Reopening Cinesim…</p>
            <button id="open-cinesim" class="primary-button" type="button">Open Cinesim</button>
          </div>

          <div id="auth-content">
            <div class="heading">
              <h1 id="auth-title">Continue to Cinesim</h1>
            </div>

            <div id="auth-options">
              <button id="google-sign-in" class="google-button" type="button">
                <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17">
                  <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.32 2.98-7.41Z"/>
                  <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.36l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"/>
                  <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.55l3.35-2.62Z"/>
                  <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.88A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z"/>
                </svg>
                Continue with Google
              </button>
              <p id="google-help" class="provider-help" hidden>
                Google sign-in is not configured in this environment yet.
              </p>

              <div class="divider"><span>or continue with email</span></div>

              <div class="mode-switch" role="tablist" aria-label="Authentication mode">
                <button id="sign-in-tab" role="tab" aria-selected="true" type="button">Sign in</button>
                <button id="sign-up-tab" role="tab" aria-selected="false" type="button">Create account</button>
              </div>
            </div>

            <form id="auth-form" novalidate>
              <label id="name-field" hidden>
                <span>Name</span>
                <input id="name" name="name" autocomplete="name" maxlength="80" />
              </label>
              <label id="email-field">
                <span>Email</span>
                <input id="email" name="email" type="email" autocomplete="email" required maxlength="320" />
              </label>
              <div id="password-field" class="form-field">
                <div class="field-heading">
                  <label id="password-label" for="password">Password</label>
                  <button id="forgot-password" class="text-button" type="button">Forgot password?</button>
                </div>
                <input id="password" name="password" type="password" autocomplete="current-password" required minlength="10" maxlength="128" />
              </div>
              <label id="confirm-password-field" hidden>
                <span>Confirm new password</span>
                <input id="confirm-password" name="confirm-password" type="password" autocomplete="new-password" minlength="10" maxlength="128" />
              </label>
              <button id="submit" class="primary-button" type="submit">Sign in</button>
              <button id="back-to-sign-in" class="text-button form-back" type="button" hidden>Back to sign in</button>
            </form>

            <p class="privacy-note">Authentication is handled in this browser. Your Cinesim editor never receives your password.</p>
          </div>
        </section>
        <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
      </div>
    </main>
    <script type="module" src="/auth-ui/auth.js"></script>
  </body>
</html>`;
}
