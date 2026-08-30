import { BrandGoogle, User, cn } from "@cinesim/ui";
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
  return <BrandGoogle className={className} aria-hidden="true" />;
}
