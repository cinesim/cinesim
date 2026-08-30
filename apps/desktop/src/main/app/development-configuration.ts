import { resolve } from "node:path";

const MAX_PROJECT_PATH_LENGTH = 4_096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export interface DevelopmentConfiguration {
  enabled: boolean;
  rendererUrl: URL | null;
  diagnosticProject: string | null;
}

export interface DevelopmentConfigurationInput {
  isPackaged: boolean;
  rendererUrl?: string | undefined;
  diagnosticProject?: string | undefined;
}

function parseRendererUrl(configuredUrl: string): URL {
  let rendererUrl: URL;
  try {
    rendererUrl = new URL(configuredUrl);
  } catch {
    throw new Error("CINESIM_DEV_SERVER_URL must be a valid URL");
  }
  if (rendererUrl.protocol !== "http:")
    throw new Error("The development renderer must use loopback HTTP");
  if (!LOOPBACK_HOSTS.has(rendererUrl.hostname))
    throw new Error("The development renderer must use an explicit loopback host");
  if (!rendererUrl.port) throw new Error("The development renderer must use an explicit port");
  if (rendererUrl.username || rendererUrl.password)
    throw new Error("The development renderer URL cannot contain credentials");
  return rendererUrl;
}

function parseDiagnosticProject(configuredProject: string | undefined): string | null {
  if (!configuredProject) return null;
  if (configuredProject.length > MAX_PROJECT_PATH_LENGTH)
    throw new Error("The diagnostic project path is too long");
  return resolve(configuredProject);
}

export function parseDevelopmentConfiguration(
  input: DevelopmentConfigurationInput,
): DevelopmentConfiguration {
  const configuredUrl = input.rendererUrl?.trim();
  const configuredProject = input.diagnosticProject?.trim();

  if (input.isPackaged) {
    if (configuredUrl || configuredProject)
      throw new Error("Development configuration is not allowed in a packaged application");
    return { enabled: false, rendererUrl: null, diagnosticProject: null };
  }

  if (!configuredUrl) {
    if (configuredProject)
      throw new Error("A diagnostic project requires a validated development renderer URL");
    return { enabled: false, rendererUrl: null, diagnosticProject: null };
  }

  return {
    enabled: true,
    rendererUrl: parseRendererUrl(configuredUrl),
    diagnosticProject: parseDiagnosticProject(configuredProject),
  };
}
