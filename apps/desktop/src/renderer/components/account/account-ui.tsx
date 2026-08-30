import { User } from "@cinesim/ui";
import { cn } from "@cinesim/ui";
import type { AccountSnapshot, AccountUser } from "../../../shared/contracts";

export function accountDisplayName(account: AccountSnapshot): string {
  if (!account.user) return account.status === "offline" ? "Offline" : "Sign in";
  const firstName = account.user.name.trim().split(/\s+/)[0];
  return firstName || account.user.email;
}

function accountInitials(user: AccountUser): string {
  const parts = user.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  return (parts[0] || user.email).slice(0, 2).toUpperCase();
}

export function AccountAvatar({
  user,
  size = "sm",
}: {
  user: AccountUser | null;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass = size === "lg" ? "size-12" : size === "md" ? "size-9" : "size-5";
  if (user?.image)
    return (
      <img
        className={cn(sizeClass, "shrink-0 rounded-full bg-surface object-cover")}
        src={user.image}
        alt=""
      />
    );
  if (user)
    return (
      <span
        className={cn(
          sizeClass,
          "grid shrink-0 place-items-center rounded-full bg-accent font-semibold text-on-accent",
          size === "lg" ? "text-ui" : "text-[10px]",
        )}
        aria-hidden="true"
      >
        {accountInitials(user)}
      </span>
    );
  return (
    <span
      className={cn(
        sizeClass,
        "grid shrink-0 place-items-center rounded-full border border-border bg-surface text-secondary",
      )}
      aria-hidden="true"
    >
      <User size={size === "lg" ? 18 : size === "md" ? 15 : 12} />
    </span>
  );
}

export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.32 2.98-7.41Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.98-.9 6.63-2.36l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.55l3.35-2.62Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.88A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z"
      />
    </svg>
  );
}
