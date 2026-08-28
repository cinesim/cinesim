import { describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../src/shared/api";
import { accountDisplayName } from "../src/renderer/components/account/account-ui";

const baseAccount: AccountSnapshot = {
  status: "signed-out",
  cloudOrigin: "http://127.0.0.1:8787",
  serviceAvailable: true,
  googleSignIn: true,
  user: null,
  detail: null,
};

describe("account footer label", () => {
  it("labels the signed-out state", () => {
    expect(accountDisplayName(baseAccount)).toBe("Sign in");
  });

  it("shows a clear offline state", () => {
    expect(accountDisplayName({ ...baseAccount, status: "offline" })).toBe("Offline");
  });

  it("uses the signed-in user's first name", () => {
    expect(
      accountDisplayName({
        ...baseAccount,
        status: "signed-in",
        user: {
          id: "user-1",
          name: "Charlie Cardozo",
          email: "charlie@example.com",
          emailVerified: true,
          image: null,
        },
      }),
    ).toBe("Charlie");
  });
});
