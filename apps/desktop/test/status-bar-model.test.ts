import { describe, expect, it } from "vite-plus/test";
import type { AccountSnapshot } from "../src/shared/contracts";
import { appStatus } from "../src/renderer/components/shell/status-bar-model";

const account: AccountSnapshot = {
  status: "signed-out",
  cloudOrigin: null,
  serviceAvailable: true,
  googleSignIn: false,
  cloudStorage: false,
  transcription: false,
  user: null,
  detail: null,
};

function status(overrides: Partial<Parameters<typeof appStatus>[0]> = {}) {
  const current = appStatus({
    account,
    cloudTransfers: [],
    derivedMedia: null,
    operationError: null,
    project: { status: "idle" },
    ...overrides,
  });
  if (!current) throw new Error("Expected an active application status");
  return current;
}

describe("application status bar", () => {
  it("reports application startup", () => {
    expect(status({ project: { status: "booting" } }).summary).toBe("Starting Cinesim…");
  });

  it("describes project creation and opening without a floating overlay", () => {
    expect(
      status({
        project: {
          status: "opening",
          operation: "create",
          previousSession: null,
          requestId: 1,
        },
      }).summary,
    ).toBe("Creating project…");
    expect(
      status({
        project: {
          status: "opening",
          operation: "open-recent",
          previousSession: null,
          requestId: 2,
        },
      }).summary,
    ).toBe("Opening project…");
  });

  it("prioritizes actionable errors over current activity", () => {
    const current = status({
      operationError: "The project could not be opened",
      project: {
        status: "opening",
        operation: "open",
        previousSession: null,
        requestId: 1,
      },
    });
    expect(current.tone).toBe("error");
    expect(current.summary).toBe("The project could not be opened");
    expect(current.dismissible).toBe(true);
  });

  it("shows cloud transfer failures and progress", () => {
    expect(
      status({
        cloudTransfers: [
          {
            assetId: "asset_fixture",
            cloudAssetId: null,
            name: "Interview.mov",
            bytes: 100,
            uploadedBytes: 25,
            state: "uploading",
            error: null,
          },
        ],
      }).summary,
    ).toBe("Uploading Interview.mov · 25%");

    const failed = status({
      cloudTransfers: [
        {
          assetId: "asset_fixture",
          cloudAssetId: null,
          name: "Interview.mov",
          bytes: 100,
          uploadedBytes: 25,
          state: "failed",
          error: "Network unavailable",
        },
      ],
    });
    expect(failed.tone).toBe("error");
    expect(failed.detail).toBe("Network unavailable");
  });
});
