export const rendererContentSecurityPolicyPlaceholder = "__CINESIM_RENDERER_CSP__";

const commonDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: cinesim-media:",
  "media-src 'self' blob: cinesim-media:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

export function rendererContentSecurityPolicy(development: boolean): string {
  const connectSources = development
    ? "connect-src 'self' ws://127.0.0.1:* cinesim-media:"
    : "connect-src 'self' cinesim-media:";
  return [...commonDirectives.slice(0, 5), connectSources, ...commonDirectives.slice(5)].join("; ");
}

export function applyRendererContentSecurityPolicy(html: string, development: boolean): string {
  if (!html.includes(rendererContentSecurityPolicyPlaceholder)) {
    throw new Error("Renderer HTML is missing its content-security-policy placeholder");
  }
  return html.replace(
    rendererContentSecurityPolicyPlaceholder,
    rendererContentSecurityPolicy(development),
  );
}
