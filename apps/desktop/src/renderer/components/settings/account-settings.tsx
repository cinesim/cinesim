import { useState } from "react";
import { Check, RefreshCw, User } from "@cinesim/ui";
import { cn, Skeleton } from "@cinesim/ui";
import { useDelayedBusy } from "../../hooks/use-delayed-busy";
import { useRendererStore } from "../../store/renderer-store-context";
import { AccountAvatar, GoogleMark } from "../account/account-ui";
import { SettingsHeading } from "./settings-layout";

export function AccountSettings() {
  const account = useRendererStore((state) => state.account);
  const accountHydrated = useRendererStore((state) => state.accountHydrated);
  const beginSignIn = useRendererStore((state) => state.beginAccountSignIn);
  const signOut = useRendererStore((state) => state.signOutAccount);
  const refresh = useRendererStore((state) => state.refreshAccount);
  const reportError = useRendererStore((state) => state.reportError);
  const [busy, setBusy] = useState<"email" | "google" | "sign-out" | "refresh" | null>(null);
  const showLoading = useDelayedBusy(!accountHydrated);

  async function startSignIn(method: "email" | "google"): Promise<void> {
    setBusy(method);
    const result = await beginSignIn(method);
    if (!result.ok) reportError(result.error);
    setBusy(null);
  }

  async function handleSignOut(): Promise<void> {
    setBusy("sign-out");
    const result = await signOut();
    if (!result.ok) reportError(result.error);
    setBusy(null);
  }

  async function handleRefresh(): Promise<void> {
    setBusy("refresh");
    await refresh();
    setBusy(null);
  }

  if (!accountHydrated)
    return (
      <div className="min-h-40" aria-busy="true">
        {showLoading && <Skeleton className="h-32 rounded-xl border border-border bg-panel" />}
      </div>
    );

  return (
    <div className="max-w-xl">
      <SettingsHeading
        icon={<User size={18} />}
        title="Account"
        detail="Manage how you sign in to Cinesim"
      />
      {account.status === "signed-in" && account.user ? (
        <div className="rounded-xl border border-border bg-panel p-6">
          <div className="flex items-center gap-4">
            <AccountAvatar user={account.user} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui font-semibold text-primary">{account.user.name}</p>
              <p className="truncate text-ui text-muted">{account.user.email}</p>
              <p className="mt-1 flex items-center gap-1 text-ui-xs text-emerald-500">
                <Check size={12} /> Email verified
              </p>
            </div>
          </div>
          <div className="mt-6 flex justify-end border-t border-border pt-5">
            <button
              className="h-8 rounded-md border border-border px-3 text-ui text-secondary hover:bg-surface hover:text-primary disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void handleSignOut()}
            >
              {busy === "sign-out" ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      ) : !account.serviceAvailable ? (
        <div className="rounded-xl border border-border bg-panel p-6">
          <p className="text-ui font-semibold text-primary">Account service unavailable</p>
          <p className="mt-1 max-w-md text-ui leading-5 text-muted">
            Local editing still works normally. Try again when the authentication service is
            available.
          </p>
          {account.detail && (
            <p className="mt-3 text-ui-xs leading-5 text-amber-500">{account.detail}</p>
          )}
          <button
            className="mt-5 flex h-8 items-center gap-1.5 rounded-md border border-border bg-panel px-3 text-ui text-secondary hover:bg-surface hover:text-primary disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={13} className={cn(busy === "refresh" && "animate-spin")} />
            {busy === "refresh" ? "Checking…" : "Try again"}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-panel p-6">
          <p className="text-ui font-semibold text-primary">Sign in to Cinesim</p>
          <div className="mt-6 space-y-2">
            {account.googleSignIn && (
              <button
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 text-ui font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void startSignIn("google")}
              >
                <GoogleMark className="size-4" />
                {busy === "google" ? "Opening Google…" : "Continue with Google"}
              </button>
            )}
            <button
              className={cn(
                "h-9 w-full rounded-md px-3 text-ui font-medium disabled:opacity-50",
                account.googleSignIn
                  ? "border border-border bg-panel text-primary hover:bg-surface"
                  : "bg-accent text-on-accent hover:bg-accent-hover",
              )}
              disabled={busy !== null}
              onClick={() => void startSignIn("email")}
            >
              {busy === "email" ? "Opening browser…" : "Sign in with email"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
