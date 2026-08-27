import { useState } from "react";
import { Cloud, LoaderCircle } from "@cinesim/ui";
import { Button, Notice } from "@cinesim/ui";
import type { AccountSnapshot } from "../../../shared/api";
import type { ActionResult } from "../../store/renderer-store";
import { GoogleMark } from "./account-ui";

export function AccountGate({
  account,
  onSignIn,
}: {
  account: AccountSnapshot;
  onSignIn: (method: "email" | "google") => Promise<ActionResult<void>>;
}) {
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(method: "email" | "google"): Promise<void> {
    setBusy(method);
    setError(null);
    const result = await onSignIn(method);
    setBusy(null);
    if (!result.ok) setError(result.error);
  }

  return (
    <main className="grid h-screen place-items-center bg-canvas px-6">
      <section className="w-full max-w-sm rounded-xl border border-border bg-panel p-6 shadow-2xl shadow-black/20">
        <span className="grid size-10 place-items-center rounded-lg bg-accent text-on-accent">
          <Cloud size={20} />
        </span>
        <h1 className="mt-5 text-ui-lg font-semibold text-primary">Sign in to Cinesim</h1>
        <p className="mt-2 text-ui leading-5 text-muted">
          Your project files stay on this Mac. Your account privately stores original media and
          keeps project storage organized.
        </p>
        <div className="mt-6 space-y-2">
          {account.googleSignIn && (
            <Button
              className="w-full"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void signIn("google")}
            >
              {busy === "google" ? (
                <LoaderCircle className="animate-spin" size={14} />
              ) : (
                <GoogleMark className="size-4" />
              )}
              {busy === "google" ? "Opening Google…" : "Continue with Google"}
            </Button>
          )}
          <Button
            className="w-full"
            variant={account.googleSignIn ? "secondary" : "primary"}
            disabled={!account.serviceAvailable || busy !== null}
            onClick={() => void signIn("email")}
          >
            {busy === "email" && <LoaderCircle className="animate-spin" size={14} />}
            {busy === "email" ? "Opening browser…" : "Sign in with email"}
          </Button>
        </div>
        {(error || !account.serviceAvailable) && (
          <Notice className="mt-4" size="default">
            {error ?? account.detail ?? "The Cinesim account service is unavailable."}
          </Notice>
        )}
      </section>
    </main>
  );
}
