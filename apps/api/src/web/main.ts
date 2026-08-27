import { electronProxyClient } from "@better-auth/electron/proxy";
import { createAuthClient } from "better-auth/client";
import { encodeDesktopAuthorizationCode, shouldCompleteDesktopTransfer } from "./desktop-transfer";
import "./style.css";

type AuthMode = "sign-in" | "sign-up" | "forgot-password" | "reset-password";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing auth UI element: ${selector}`);
  return element;
}

const scheme = requiredElement<HTMLMetaElement>('meta[name="cinesim-desktop-scheme"]').content;
const localCallback = requiredElement<HTMLMetaElement>(
  'meta[name="cinesim-local-callback"]',
).content;
const googleEnabled =
  requiredElement<HTMLMetaElement>('meta[name="cinesim-google-enabled"]').content === "true";
const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [
    electronProxyClient({
      clientID: "cinesim-desktop",
      protocol: { scheme },
    }),
  ],
});

const authContent = requiredElement<HTMLElement>("#auth-content");
const authenticated = requiredElement<HTMLElement>("#authenticated");
const notice = requiredElement<HTMLElement>("#notice");
const authTitle = requiredElement<HTMLElement>("#auth-title");
const authOptions = requiredElement<HTMLElement>("#auth-options");
const form = requiredElement<HTMLFormElement>("#auth-form");
const nameField = requiredElement<HTMLLabelElement>("#name-field");
const nameInput = requiredElement<HTMLInputElement>("#name");
const emailField = requiredElement<HTMLLabelElement>("#email-field");
const emailInput = requiredElement<HTMLInputElement>("#email");
const passwordField = requiredElement<HTMLElement>("#password-field");
const passwordLabel = requiredElement<HTMLLabelElement>("#password-label");
const passwordInput = requiredElement<HTMLInputElement>("#password");
const confirmPasswordField = requiredElement<HTMLLabelElement>("#confirm-password-field");
const confirmPasswordInput = requiredElement<HTMLInputElement>("#confirm-password");
const submit = requiredElement<HTMLButtonElement>("#submit");
const forgotPassword = requiredElement<HTMLButtonElement>("#forgot-password");
const backToSignIn = requiredElement<HTMLButtonElement>("#back-to-sign-in");
const signInTab = requiredElement<HTMLButtonElement>("#sign-in-tab");
const signUpTab = requiredElement<HTMLButtonElement>("#sign-up-tab");
const googleButton = requiredElement<HTMLButtonElement>("#google-sign-in");
const googleHelp = requiredElement<HTMLElement>("#google-help");
const openCinesim = requiredElement<HTMLButtonElement>("#open-cinesim");
const returnStatus = requiredElement<HTMLElement>("#return-status");
const query = Object.fromEntries(new URLSearchParams(window.location.search));
const transientQueryKeys = new Set([
  "auth_complete",
  "error",
  "oauth_error",
  "reset_password",
  "token",
  "verified",
]);
const persistentQuery = Object.fromEntries(
  Object.entries(query).filter(([key]) => !transientQueryKeys.has(key)),
);
const isDesktopFlow = Boolean(
  persistentQuery.client_id && persistentQuery.state && persistentQuery.code_challenge,
);
const completingExplicitAuthentication = shouldCompleteDesktopTransfer(query);
let mode: AuthMode = "sign-in";
let busy = false;
let returning = false;
let returned = false;
let authorizationExpected = completingExplicitAuthentication;
let pendingAuthorizationCode: string | null = null;

function callbackUrl(extra: Record<string, string> = {}): string {
  const url = new URL("/sign-in", window.location.origin);
  for (const [key, value] of Object.entries(persistentQuery)) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

function errorMessage(
  error: { message?: string | undefined; code?: string | undefined } | null,
): string {
  if (!error) return "Authentication did not complete. Please try again.";
  if (error.code === "EMAIL_NOT_VERIFIED")
    return "Check your inbox for a verification link before signing in.";
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") return "The email or password is incorrect.";
  if (error.code === "INVALID_TOKEN")
    return "This password reset link is invalid or expired. Request a new one.";
  if (error.code === "PASSWORD_TOO_SHORT") return "Use a password with at least 10 characters.";
  if (error.code === "PASSWORD_TOO_LONG") return "Use a password with no more than 128 characters.";
  if (
    error.code === "USER_ALREADY_EXISTS" ||
    error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  )
    return "An account already exists with this email. Sign in using your original method.";
  return error.message || "Authentication did not complete. Please try again.";
}

function showNotice(message: string, kind: "info" | "error" = "info"): void {
  clearNotice();
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
}

function clearNotice(): void {
  notice.hidden = true;
  notice.textContent = "";
  delete notice.dataset.kind;
}

function submitLabel(): string {
  if (mode === "sign-up") return "Create account";
  if (mode === "forgot-password") return "Send reset link";
  if (mode === "reset-password") return "Reset password";
  return "Sign in";
}

function setBusy(next: boolean): void {
  busy = next;
  submit.disabled = next;
  googleButton.disabled = next || !googleEnabled;
  signInTab.disabled = next;
  signUpTab.disabled = next;
  forgotPassword.disabled = next;
  backToSignIn.disabled = next;
  submit.textContent = next ? "Please wait…" : submitLabel();
}

function setMode(next: AuthMode): void {
  mode = next;
  clearNotice();
  const signingUp = next === "sign-up";
  const requestingReset = next === "forgot-password";
  const resettingPassword = next === "reset-password";
  const recovering = requestingReset || resettingPassword;
  authTitle.textContent = requestingReset
    ? "Reset your password"
    : resettingPassword
      ? "Choose a new password"
      : "Continue to Cinesim";
  authOptions.hidden = recovering;
  nameField.hidden = !signingUp;
  nameInput.required = signingUp;
  emailField.hidden = resettingPassword;
  emailInput.required = !resettingPassword;
  passwordField.hidden = requestingReset;
  passwordInput.required = !requestingReset;
  passwordLabel.textContent = resettingPassword ? "New password" : "Password";
  passwordInput.autocomplete = signingUp || resettingPassword ? "new-password" : "current-password";
  confirmPasswordField.hidden = !resettingPassword;
  confirmPasswordInput.required = resettingPassword;
  if (!resettingPassword) confirmPasswordInput.setCustomValidity("");
  forgotPassword.hidden = next !== "sign-in";
  backToSignIn.hidden = !recovering;
  signInTab.setAttribute("aria-selected", String(!signingUp));
  signUpTab.setAttribute("aria-selected", String(signingUp));
  submit.textContent = submitLabel();
}

async function handleEmailSubmit(): Promise<void> {
  if (busy || !form.reportValidity()) return;
  if (mode === "reset-password" && passwordInput.value !== confirmPasswordInput.value) {
    confirmPasswordInput.setCustomValidity("Passwords do not match.");
    confirmPasswordInput.reportValidity();
    return;
  }
  setBusy(true);
  clearNotice();
  try {
    if (mode === "sign-up") {
      const result = await authClient.signUp.email({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        password: passwordInput.value,
        callbackURL: callbackUrl({ verified: "true" }),
        fetchOptions: { query: persistentQuery },
      });
      if (result.error) showNotice(errorMessage(result.error), "error");
      else {
        passwordInput.value = "";
        showNotice("Check your email.");
      }
    } else if (mode === "sign-in") {
      const result = await authClient.signIn.email({
        email: emailInput.value.trim(),
        password: passwordInput.value,
        callbackURL: callbackUrl({ auth_complete: "email" }),
        fetchOptions: { query: persistentQuery },
      });
      if (result.error) showNotice(errorMessage(result.error), "error");
      else {
        showNotice("Signed in. Reopening Cinesim…");
        await completeExplicitAuthentication();
      }
    } else if (mode === "forgot-password") {
      const result = await authClient.requestPasswordReset({
        email: emailInput.value.trim(),
        redirectTo: callbackUrl({ reset_password: "true" }),
        fetchOptions: { query: persistentQuery },
      });
      if (result.error) showNotice(errorMessage(result.error), "error");
      else
        showNotice(
          "If an account exists with this email, check your email for a password reset link.",
        );
    } else {
      const result = await authClient.resetPassword({
        newPassword: passwordInput.value,
        token: query.token ?? "",
        fetchOptions: { query: persistentQuery },
      });
      if (result.error) showNotice(errorMessage(result.error), "error");
      else {
        passwordInput.value = "";
        confirmPasswordInput.value = "";
        window.history.replaceState({}, "", callbackUrl());
        setMode("sign-in");
        showNotice("Password updated. You can sign in now.");
      }
    }
  } catch {
    showNotice("The local authentication server is unavailable.", "error");
  } finally {
    setBusy(false);
  }
}

signInTab.addEventListener("click", () => setMode("sign-in"));
signUpTab.addEventListener("click", () => setMode("sign-up"));
forgotPassword.addEventListener("click", () => setMode("forgot-password"));
backToSignIn.addEventListener("click", () => setMode("sign-in"));
confirmPasswordInput.addEventListener("input", () => confirmPasswordInput.setCustomValidity(""));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleEmailSubmit();
});

googleButton.disabled = !googleEnabled;
googleHelp.hidden = googleEnabled;
googleButton.addEventListener("click", () => {
  if (!googleEnabled || busy) return;
  setBusy(true);
  clearNotice();
  const completedUrl = callbackUrl({ auth_complete: "google" });
  void authClient.signIn
    .social({
      provider: "google",
      callbackURL: completedUrl,
      newUserCallbackURL: completedUrl,
      errorCallbackURL: callbackUrl({ oauth_error: "true" }),
      fetchOptions: { query: persistentQuery },
    })
    .then((result) => {
      if (result?.error) showNotice(errorMessage(result.error), "error");
    })
    .catch(() => showNotice("Google sign-in could not be started.", "error"))
    .finally(() => setBusy(false));
});

function clearAuthorizationCode(): void {
  document.cookie = "better-auth.cinesim-desktop=; Max-Age=0; Path=/; SameSite=Lax";
}

async function returnToDesktop(providedCode?: string): Promise<void> {
  if (returning || returned) return;
  const code =
    providedCode ?? pendingAuthorizationCode ?? authClient.electron.getAuthorizationCode();
  if (!code) return;
  pendingAuthorizationCode = code;
  returning = true;
  clearNotice();
  authContent.hidden = true;
  authenticated.hidden = false;
  returnStatus.textContent = "Reopening Cinesim…";
  returnStatus.hidden = false;
  openCinesim.disabled = true;
  try {
    if (localCallback) {
      const response = await fetch(localCallback, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: code }),
      });
      if (!response.ok) throw new Error(`Desktop callback returned ${response.status}`);
      clearAuthorizationCode();
      pendingAuthorizationCode = null;
      returned = true;
      returnStatus.textContent = "";
      returnStatus.hidden = true;
      openCinesim.hidden = true;
      return;
    }
    clearAuthorizationCode();
    pendingAuthorizationCode = null;
    returned = true;
    window.location.replace(`${scheme}://auth/callback#token=${code}`);
  } catch {
    returnStatus.hidden = false;
    returnStatus.textContent =
      "Cinesim couldn’t be reached. Make sure the desktop app is open, then try again.";
    openCinesim.textContent = "Try again";
    openCinesim.disabled = false;
  } finally {
    returning = false;
  }
}

openCinesim.addEventListener("click", () => void returnToDesktop());

async function transferExistingSession(): Promise<void> {
  if (!isDesktopFlow || returning || returned) return;
  const session = await authClient.getSession();
  if (!session.data) return;

  const url = new URL("/api/auth/electron/transfer-user", window.location.origin);
  url.searchParams.set("client_id", persistentQuery.client_id ?? "");
  url.searchParams.set("state", persistentQuery.state ?? "");
  url.searchParams.set("code_challenge", persistentQuery.code_challenge ?? "");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) return;
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("electron_authorization_code" in result) ||
    typeof result.electron_authorization_code !== "string" ||
    !persistentQuery.state
  )
    return;
  const code = encodeDesktopAuthorizationCode(
    result.electron_authorization_code,
    persistentQuery.state,
  );
  await returnToDesktop(code);
}

async function completeExplicitAuthentication(): Promise<void> {
  authorizationExpected = true;
  const code = authClient.electron.getAuthorizationCode();
  if (code) {
    await returnToDesktop(code);
    return;
  }
  await transferExistingSession();
}

if (query.reset_password === "true" && query.token) setMode("reset-password");
else if (query.reset_password === "true" && query.error) {
  setMode("forgot-password");
  showNotice("This password reset link is invalid or expired. Request a new one.", "error");
}
if (query.verified !== undefined) showNotice("Email verified. Finishing sign-in…");
if (query.oauth_error !== undefined)
  showNotice("Google sign-in was cancelled or could not be completed.", "error");
if (
  !isDesktopFlow &&
  query.reset_password !== "true" &&
  !authClient.electron.getAuthorizationCode()
)
  showNotice("Open this page from Cinesim to connect the account to the desktop app.");

const redirectTimer = window.setInterval(() => {
  if (!authorizationExpected) return;
  if (!authClient.electron.getAuthorizationCode()) return;
  window.clearInterval(redirectTimer);
  void returnToDesktop();
}, 100);
const redirectTimeout = window.setTimeout(() => window.clearInterval(redirectTimer), 5 * 60_000);
if (completingExplicitAuthentication)
  window.setTimeout(() => void completeExplicitAuthentication(), 250);
else clearAuthorizationCode();
window.addEventListener("beforeunload", () => {
  window.clearInterval(redirectTimer);
  window.clearTimeout(redirectTimeout);
});
