import { useState } from "react";
import { LoaderCircle, LogOut } from "@cinesim/ui";
import { Button, cn, Menu, MenuContent, MenuItem, MenuTrigger } from "@cinesim/ui";
import { useRendererStore } from "../../store/renderer-store-context";
import { AccountAvatar, accountDisplayName, GoogleMark } from "../account/account-ui";

interface AccountMenuProps {
  width: number;
}

export function AccountMenu({ width }: AccountMenuProps) {
  const account = useRendererStore((state) => state.account);
  const hydrated = useRendererStore((state) => state.accountHydrated);
  const beginSignIn = useRendererStore((state) => state.beginAccountSignIn);
  const signOutAccount = useRendererStore((state) => state.signOutAccount);
  const reportError = useRendererStore((state) => state.reportError);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"email" | "google" | "sign-out" | null>(null);

  async function startSignIn(method: "email" | "google"): Promise<void> {
    setBusy(method);
    const result = await beginSignIn(method);
    setBusy(null);
    if (result.ok) setOpen(false);
    else {
      reportError(result.error);
      setOpen(false);
    }
  }

  async function signOut(): Promise<void> {
    setBusy("sign-out");
    const result = await signOutAccount();
    setBusy(null);
    if (result.ok) setOpen(false);
    else {
      reportError(result.error);
      setOpen(false);
    }
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
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
        className="border-0 bg-surface p-2"
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
            {!account.serviceAvailable && (
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
