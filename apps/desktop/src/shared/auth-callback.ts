export function parseDesktopAuthCallback(value: string, scheme: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${scheme}:` ||
    `/${url.hostname}${url.pathname}` !== "/auth/callback" ||
    !url.hash.startsWith("#token=")
  )
    return null;
  const token = url.hash.slice("#token=".length);
  return token || null;
}
