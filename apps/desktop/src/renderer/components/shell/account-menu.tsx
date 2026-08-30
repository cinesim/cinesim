import { useState } from "react";
import { LoaderCircle, LogOut } from "@cinesim/ui";
import { Button, cn, Menu, MenuContent, MenuItem, MenuTrigger } from "@cinesim/ui";
import type { AccountSnapshot } from "../../../shared/api";
import { AccountAvatar, accountDisplayName, GoogleMark } from "../account/account-ui";

export type AccountActionResult = { ok: true } | { ok: false; error: string };

interface AccountMenuProps {
  account: AccountSnapshot;
  hydrated: boolean;
  width: number;
  onSignIn: (method: "email" | "google") => Promise<AccountActionResult>;
  onSignOut: () => Promise<AccountActionResult>;
}

export function AccountMenu({ account, hydrated, width, onSignIn, onSignOut }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"email" | "google" | "sign-out" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function startSignIn(method: "email" | "google"): Promise<void> {
    setBusy(method);
    setMessage(null);
    const result = await onSignIn(method);
    setBusy(null);
    if (result.ok) setOpen(false);
    else setMessage(result.error);
  }

  async function signOut(): Promise<void> {
    setBusy("sign-out");
    setMessage(null);
    const result = await onSignOut();
    setBusy(null);
    if (result.ok) setOpen(false);
    else setMessage(result.error);
  }

  return (
    <Menu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setMessage(null);
      }}
    >
      <MenuTrigger
        className={cn(
          "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-ui text-secondary transition-colors hover:bg-surface hover:text-primary",
          open && "bg-surface text-primary",
        )}
        aria-label="Account menu"
      >
        <AccountAvatar user={hydrated ? account.user : null} />
        <span className="min-w-0 flex-1 truncate">
          {hydrated ? accountDisplayName(account) : "Account"}
        </span>
        {hydrated && account.status === "offline" && account.user && (
          <span className="shrink-0 text-ui-xs text-amber-500">Offline</span>
        )}
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="p-2"
        style={{ width: width - 16 }}
      >
        {!hydrated ? (
          <div className="flex items-center gap-3 px-2 py-2" aria-busy="true">
            <AccountAvatar user={null} size="md" />
            <p className="text-ui text-muted">Checking account…</p>
          </div>
        ) : account.status === "signed-in" && account.user ? (
          <div className="flex items-center gap-3 px-2 py-2">
            <AccountAvatar user={account.user} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui font-semibold text-primary">{account.user.name}</p>
              <p className="truncate text-ui-xs text-muted">{account.user.email}</p>
            </div>
            <MenuItem
              aria-label={busy === "sign-out" ? "Signing out" : "Sign out"}
              title={busy === "sign-out" ? "Signing out…" : "Sign out"}
              className="ml-auto size-8 min-h-0 shrink-0 justify-center p-0 text-muted"
              disabled={busy !== null}
              onClick={() => void signOut()}
            >
              {busy === "sign-out" ? (
                <LoaderCircle className="animate-spin" size={15} />
              ) : (
                <LogOut size={15} />
              )}
            </MenuItem>
          </div>
        ) : (
          <>
            <div className="px-2 py-2">
              <p className="text-ui font-semibold text-primary">Local workspace</p>
            </div>
            <div className="space-y-2 px-1 pb-1">
              <Button
                className="w-full"
                variant="primary"
                disabled={!account.googleSignIn || busy !== null}
                onClick={() => void startSignIn("google")}
              >
                <GoogleMark className="size-4" />
                {busy === "google" ? "Opening Google…" : "Continue with Google"}
              </Button>
              <Button
                className="w-full"
                variant="secondary"
                disabled={!account.serviceAvailable || busy !== null}
                onClick={() => void startSignIn("email")}
              >
                {busy === "email" ? "Opening browser…" : "Sign in with email"}
              </Button>
            </div>
            {message && <p className="px-2 pt-2 text-ui-xs leading-5 text-red-400">{message}</p>}
            {!account.serviceAvailable && !message && (
              <p className="px-2 pt-2 text-ui-xs leading-5 text-amber-500">
                {account.detail ?? "The account service is unavailable."}
              </p>
            )}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
