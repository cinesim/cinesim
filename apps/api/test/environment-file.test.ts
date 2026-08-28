import { describe, expect, it } from "vitest";
import {
  backfillMissingEnvironmentVariables,
  populateAuthSecret,
} from "../scripts/environment-file.mjs";

const example = `CINESIM_ENV=development
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
CLOUDFLARE_R2_ACCOUNT_ID=
CLOUDFLARE_R2_BUCKET=
CINESIM_CLOUD_INCLUDED_BYTES=10737418240
`;

describe("local environment setup", () => {
  it("populates the generated auth secret", () => {
    expect(populateAuthSecret(example, "generated-secret")).toContain(
      "BETTER_AUTH_SECRET=generated-secret",
    );
  });

  it("adds missing settings without changing existing values", () => {
    const existing = `CINESIM_ENV=custom
BETTER_AUTH_SECRET=existing-secret
CLOUDFLARE_R2_ACCOUNT_ID=existing-account
`;

    const result = backfillMissingEnvironmentVariables(existing, example, "generated-secret");

    expect(result.addedKeys).toEqual(["CLOUDFLARE_R2_BUCKET", "CINESIM_CLOUD_INCLUDED_BYTES"]);
    expect(result.contents).toContain("CINESIM_ENV=custom");
    expect(result.contents).toContain("BETTER_AUTH_SECRET=existing-secret");
    expect(result.contents).toContain("CLOUDFLARE_R2_ACCOUNT_ID=existing-account");
    expect(result.contents).toContain("CLOUDFLARE_R2_BUCKET=");
    expect(result.contents).toContain("CINESIM_CLOUD_INCLUDED_BYTES=10737418240");
    expect(result.contents).not.toContain("generated-secret");
  });

  it("uses a generated secret when an old environment is missing one", () => {
    const result = backfillMissingEnvironmentVariables(
      "CINESIM_ENV=development\n",
      example,
      "generated-secret",
    );

    expect(result.contents).toContain("BETTER_AUTH_SECRET=generated-secret");
    expect(result.contents).not.toContain("replace-with-at-least-32-random-characters");
  });

  it("is idempotent after missing settings are added", () => {
    const first = backfillMissingEnvironmentVariables(
      "CINESIM_ENV=development\n",
      example,
      "generated-secret",
    );
    const second = backfillMissingEnvironmentVariables(first.contents, example, "another-secret");

    expect(second.addedKeys).toEqual([]);
    expect(second.contents).toBe(first.contents);
  });
});
