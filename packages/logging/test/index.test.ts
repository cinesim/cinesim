import { describe, expect, it } from "vite-plus/test";
import { formatTerminalLogLine } from "../src";

describe("terminal log formatting", () => {
  it("formats a log entry without changing its contextual fields", () => {
    expect(
      formatTerminalLogLine({
        level: 30,
        time: 0,
        app: "cinesim",
        service: "derived-media",
        operation: "protocol-read",
        assetId: "asset_000001",
        bytesRead: 96912,
        msg: "media protocol range served",
      }),
    ).toBe(
      "1970-01-01 00:00:00Z  INFO   derived-media  protocol-read  media protocol range served\n" +
        "  assetId=asset_000001 bytesRead=96912\n",
    );
  });

  it("colors the terminal presentation while leaving values readable", () => {
    const formatted = formatTerminalLogLine(
      { level: 40, time: 0, service: "desktop", msg: "warning" },
      true,
    );

    expect(formatted).toContain("\u001b[33mWARN ");
    expect(formatted).toContain("\u001b[36mdesktop");
    expect(formatted).toContain("warning");
  });

  it("removes terminal control sequences from logged values", () => {
    expect(formatTerminalLogLine({ level: 30, msg: "hello\u001b[31m\nworld\u0007" })).toContain(
      "hello world?",
    );
  });
});
