import { z } from "zod";
import type { RegisteredProject } from "../../shared/contracts";

const MAX_ACCOUNT_JSON_BYTES = 1024 * 1024;

const accountResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().max(1_024),
        email: z.email().max(1_024),
        emailVerified: z.boolean(),
        image: z.string().max(8_192).nullable(),
      })
      .strict(),
  })
  .strict();

const healthResponseSchema = z
  .object({
    ok: z.literal(true),
    environment: z.enum(["development", "test", "preview", "staging", "production"]),
    googleSignIn: z.boolean(),
    cloudStorage: z.boolean(),
    transcription: z.boolean(),
  })
  .strict();

const registeredProjectSchema = z
  .object({
    id: z.string().regex(/^cloud_project_[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u),
    clientProjectId: z.string().regex(/^project_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u),
    name: z.string().min(1).max(1_024),
  })
  .strict();

export type AccountResponse = z.infer<typeof accountResponseSchema>;
export type AccountHealth = z.infer<typeof healthResponseSchema>;

export class AccountGateway {
  constructor(
    private readonly origin: string,
    private readonly cookie: () => string,
  ) {}

  async account(): Promise<AccountResponse | null> {
    const response = await fetch(`${this.origin}/api/v1/account`, {
      headers: { cookie: this.cookie() },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`Account endpoint returned ${response.status}`);
    return accountResponseSchema.parse(await readBoundedJson(response));
  }

  async health(): Promise<AccountHealth> {
    const response = await fetch(`${this.origin}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
    return healthResponseSchema.parse(await readBoundedJson(response));
  }

  async registerProject(input: {
    cloudProjectId?: string | undefined;
    clientProjectId: string;
    name: string;
  }): Promise<RegisteredProject> {
    const response = await this.authenticatedFetch("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return registeredProjectSchema.parse(await readBoundedJson(response));
  }

  async authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/api/v1/")) throw new Error("Invalid Cinesim API path");
    const cookie = this.cookie();
    if (!cookie) throw new Error("Sign in to use Cinesim Cloud storage");
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    const response = await fetch(`${this.origin}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (response.status === 401) throw new Error("Sign in to use Cinesim Cloud storage");
    if (!response.ok) {
      const payload = await readBoundedJson(response).catch(() => null);
      const parsed = z
        .object({ message: z.string().max(4_096).optional() })
        .passthrough()
        .safeParse(payload);
      throw new Error(
        parsed.success && parsed.data.message
          ? parsed.data.message
          : `Cinesim service request failed (${response.status})`,
      );
    }
    return response;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACCOUNT_JSON_BYTES)
    throw new Error("Account service response exceeded its byte limit");
  if (!response.body) throw new Error("Account service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ACCOUNT_JSON_BYTES)
        throw new Error("Account service response exceeded its byte limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}
