import { describe, expect, it } from "vite-plus/test";
import { assertIpcSender, isTrustedRendererUrl } from "../src/main/app/ipc-security";
import { parseDevelopmentConfiguration } from "../src/main/app/development-configuration";

describe("privileged IPC sender policy", () => {
  const developmentPolicy = {
    trustedRendererIds: new Set([7]),
    developmentUrl: new URL("http://127.0.0.1:5173"),
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

  it("accepts only the packaged custom renderer origin outside development", () => {
    const policy = {
      trustedRendererIds: new Set([1]),
    };
    expect(isTrustedRendererUrl("cinesim://app/index.html", policy)).toBe(true);
    expect(isTrustedRendererUrl("cinesim://app/other.html", policy)).toBe(false);
  });

  it("accepts only explicit loopback development URLs in unpackaged builds", () => {
    for (const rendererUrl of [
      "https://127.0.0.1:5173",
      "http://localhost:5173",
      "http://192.168.1.10:5173",
      "file:///tmp/index.html",
      "http://user:secret@127.0.0.1:5173",
      "not a URL",
    ]) {
      expect(() => parseDevelopmentConfiguration({ isPackaged: false, rendererUrl })).toThrow();
    }
    expect(
      parseDevelopmentConfiguration({
        isPackaged: false,
        rendererUrl: "http://127.0.0.1:5173/editor",
      }).rendererUrl?.href,
    ).toBe("http://127.0.0.1:5173/editor");
    expect(
      parseDevelopmentConfiguration({
        isPackaged: false,
        rendererUrl: "http://[::1]:5173",
      }).enabled,
    ).toBe(true);
  });

  it("rejects development environment overrides in packaged builds", () => {
    expect(() =>
      parseDevelopmentConfiguration({
        isPackaged: true,
        rendererUrl: "http://127.0.0.1:5173",
      }),
    ).toThrow("not allowed");
    expect(() =>
      parseDevelopmentConfiguration({
        isPackaged: true,
        diagnosticProject: "/tmp/project",
      }),
    ).toThrow("not allowed");
  });

  it("gates and resolves diagnostic projects behind valid development mode", () => {
    expect(() =>
      parseDevelopmentConfiguration({
        isPackaged: false,
        diagnosticProject: "relative/project",
      }),
    ).toThrow("requires");
    expect(
      parseDevelopmentConfiguration({
        isPackaged: false,
        rendererUrl: "http://127.0.0.1:5173",
        diagnosticProject: "relative/project",
      }).diagnosticProject,
    ).toMatch(/\/relative\/project$/);
  });
});
