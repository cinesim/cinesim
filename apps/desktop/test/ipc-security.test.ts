import { describe, expect, it } from "vite-plus/test";
import { assertIpcSender, isTrustedRendererUrl } from "../src/main/app/ipc-security";

describe("privileged IPC sender policy", () => {
  const developmentPolicy = {
    trustedRendererIds: new Set([7]),
    developmentUrl: "http://127.0.0.1:5173",
    applicationPath: "/Applications/Cinesim.app/Contents/Resources/app.asar",
  };

  it("accepts only the registered main frame at the configured renderer origin", () => {
    const mainFrame = { url: "http://127.0.0.1:5173/projects/current" };
    expect(() =>
      assertIpcSender({ sender: { id: 7, mainFrame }, senderFrame: mainFrame }, developmentPolicy),
    ).not.toThrow();
    expect(() =>
      assertIpcSender({ sender: { id: 8, mainFrame }, senderFrame: mainFrame }, developmentPolicy),
    ).toThrow("Unauthorized IPC sender");
    expect(() =>
      assertIpcSender(
        {
          sender: { id: 7, mainFrame },
          senderFrame: { url: "http://127.0.0.1:5173/embedded" },
        },
        developmentPolicy,
      ),
    ).toThrow("Unauthorized IPC sender");
    const foreignFrame = { url: "http://attacker.invalid/" };
    expect(() =>
      assertIpcSender(
        { sender: { id: 7, mainFrame: foreignFrame }, senderFrame: foreignFrame },
        developmentPolicy,
      ),
    ).toThrow("Unauthorized IPC sender");
  });

  it("accepts only the packaged renderer entry file outside development", () => {
    const policy = {
      trustedRendererIds: new Set([1]),
      applicationPath: "/Applications/Cinesim.app/Contents/Resources/app.asar",
    };
    expect(
      isTrustedRendererUrl(
        "file:///Applications/Cinesim.app/Contents/Resources/app.asar/dist/renderer/index.html",
        policy,
      ),
    ).toBe(true);
    expect(
      isTrustedRendererUrl(
        "file:///Applications/Cinesim.app/Contents/Resources/app.asar/dist/renderer/other.html",
        policy,
      ),
    ).toBe(false);
  });
});
