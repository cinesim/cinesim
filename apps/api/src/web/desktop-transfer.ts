const identifierPattern = /^[A-Za-z0-9]+$/;

export function shouldCompleteDesktopTransfer(query: Record<string, string>): boolean {
  return query.auth_complete === "google" || query.auth_complete === "email" || "verified" in query;
}

export function encodeDesktopAuthorizationCode(identifier: string, state: string): string {
  if (!identifierPattern.test(identifier) || !identifierPattern.test(state))
    throw new Error("The desktop authorization response was invalid");
  return btoa(JSON.stringify({ identifier, state }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
