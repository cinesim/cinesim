import { electronProxyClient } from "@better-auth/electron/proxy";
import { createAuthClient } from "better-auth/client";
import { encodeDesktopAuthorizationCode, shouldCompleteDesktopTransfer } from "./desktop-transfer";
import "./style.css";

type AuthMode = "sign-in" | "sign-up";

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
const form = requiredElement<HTMLFormElement>("#auth-form");
const nameField = requiredElement<HTMLLabelElement>("#name-field");
const nameInput = requiredElement<HTMLInputElement>("#name");
const emailInput = requiredElement<HTMLInputElement>("#email");
const passwordInput = requiredElement<HTMLInputElement>("#password");
const submit = requiredElement<HTMLButtonElement>("#submit");
const signInTab = requiredElement<HTMLButtonElement>("#sign-in-tab");
const signUpTab = requiredElement<HTMLButtonElement>("#sign-up-tab");
const googleButton = requiredElement<HTMLButtonElement>("#google-sign-in");
const googleHelp = requiredElement<HTMLElement>("#google-help");
const openCinesim = requiredElement<HTMLButtonElement>("#open-cinesim");
const returnStatus = requiredElement<HTMLElement>("#return-status");
const query = Object.fromEntries(new URLSearchParams(window.location.search));
const isDesktopFlow = Boolean(query.client_id && query.state && query.code_challenge);
const completingExplicitAuthentication = shouldCompleteDesktopTransfer(query);
let mode: AuthMode = "sign-in";
let busy = false;
let returning = false;
let returned = false;
let authorizationExpected = completingExplicitAuthentication;
let pendingAuthorizationCode: string | null = null;

function callbackUrl(extra: Record<string, string> = {}): string {
  const url = new URL("/sign-in", window.location.origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
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
  return error.message || "Authentication did not complete. Please try again.";
}

function showNotice(message: string, kind: "info" | "error" = "info"): void {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
}

function clearNotice(): void {
  notice.hidden = true;
  notice.textContent = "";
}

function setBusy(next: boolean): void {
  busy = next;
  submit.disabled = next;
  googleButton.disabled = next || !googleEnabled;
  signInTab.disabled = next;
  signUpTab.disabled = next;
  submit.textContent = next ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account";
}

function setMode(next: AuthMode): void {
  mode = next;
  clearNotice();
  const signingUp = next === "sign-up";
  nameField.hidden = !signingUp;
  nameInput.required = signingUp;
  passwordInput.autocomplete = signingUp ? "new-password" : "current-password";
  signInTab.setAttribute("aria-selected", String(!signingUp));
  signUpTab.setAttribute("aria-selected", String(signingUp));
  submit.textContent = signingUp ? "Create account" : "Sign in";
}

async function handleEmailSubmit(): Promise<void> {
  if (busy || !form.reportValidity()) return;
  setBusy(true);
  clearNotice();
  try {
    if (mode === "sign-up") {
      const result = await authClient.signUp.email({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        password: passwordInput.value,
        callbackURL: callbackUrl({ verified: "true" }),
        fetchOptions: { query },
      });
      if (result.error) showNotice(errorMessage(result.error), "error");
      else {
        passwordInput.value = "";
        showNotice("Check Mailpit for your verification link, then return here.");
      }
    } else {
      const result = await authClient.signIn.email({
        email: emailInput.value.trim(),
        password: passwordInput.value,
        callbackURL: callbackUrl({ auth_complete: "email" }),
        fetchOptions: { query },
      });
      if (result.error) showNotice(errorMessage(result.error), "error");
      else {
        showNotice("Signed in. Reopening Cinesim…");
        await completeExplicitAuthentication();
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
      fetchOptions: { query },
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
  authContent.hidden = true;
  authenticated.hidden = false;
  returnStatus.textContent = "Reopening Cinesim…";
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
      returnStatus.textContent = "Cinesim is ready. You can close this window.";
      openCinesim.hidden = true;
      return;
    }
    clearAuthorizationCode();
    pendingAuthorizationCode = null;
    returned = true;
    window.location.replace(`${scheme}://auth/callback#token=${code}`);
  } catch {
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
  url.searchParams.set("client_id", query.client_id ?? "");
  url.searchParams.set("state", query.state ?? "");
  url.searchParams.set("code_challenge", query.code_challenge ?? "");
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
    !query.state
  )
    return;
  const code = encodeDesktopAuthorizationCode(result.electron_authorization_code, query.state);
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

if (new URLSearchParams(window.location.search).has("verified"))
  showNotice("Email verified. Finishing sign-in…");
if (new URLSearchParams(window.location.search).has("oauth_error"))
  showNotice("Google sign-in was cancelled or could not be completed.", "error");
if (!isDesktopFlow && !authClient.electron.getAuthorizationCode())
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
