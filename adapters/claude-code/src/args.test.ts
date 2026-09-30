import { describe, expect, test } from "bun:test";
import { DEFAULT_SOCKET_RELATIVE, parseHookArgs } from "./args.ts";

const HOME = "/home/dev";

describe("parseHookArgs: `--harness claude-code [--socket path]`", () => {
  test("the socket defaults to the daemon's under the home directory", () => {
    expect(parseHookArgs(["--harness", "claude-code"], HOME)).toEqual({
      ok: true,
      harness: "claude-code",
      socket: `${HOME}/${DEFAULT_SOCKET_RELATIVE}`,
      httpUrl: null,
    });
  });

  test("--http-url names the daemon's loopback URL (HTTP post transport)", () => {
    const argv = ["--harness", "claude-code", "--http-url", "http://127.0.0.1:8787"];
    expect(parseHookArgs(argv, HOME)).toMatchObject({ ok: true, httpUrl: "http://127.0.0.1:8787" });
  });

  test.each([
    [["--harness", "claude-code", "--socket", "/run/j.sock"]],
    [["--socket=/run/j.sock", "--harness=claude-code"]],
  ])("%p names the socket", (argv) => {
    expect(parseHookArgs(argv, HOME)).toMatchObject({ ok: true, socket: "/run/j.sock" });
  });

  test.each([
    [[], "--harness claude-code is required"],
    [["--harness", "pi"], "pi is not a hook harness"],
    [["--harness", "codex"], "unknown harness"],
    [["--harness", "claude-code", "--socket", "relative.sock"], "must be absolute"],
    [["--harness", "claude-code", "--verbose"], "Unknown option"],
    [["--harness", "claude-code", "extra"], "Unexpected argument"],
    [["--harness", "claude-code", "--http-url", "http://10.0.0.1:80"], "loopback"],
    [["--harness", "claude-code", "--http-url", "http://127.0.0.1:80/x"], "loopback"],
  ])("%p is refused: %s", (argv, message) => {
    const parsed = parseHookArgs(argv, HOME);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});
