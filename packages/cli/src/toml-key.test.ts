import { describe, expect, test } from "bun:test";
import { readDaemonHookBinary, setDaemonHookBinary, unsetDaemonHookBinary } from "./toml-key.ts";

const BIN = "/opt/jev-cops/dist/cops-hook";
const parse = (t: string) => Bun.TOML.parse(t) as Record<string, Record<string, unknown>>;

describe("setDaemonHookBinary: one key, everything else byte-identical", () => {
  test("a new file gets a [daemon] table", () => {
    const out = setDaemonHookBinary(null, BIN);
    expect(out).toBe(`[daemon]\nhook_binary = "${BIN}"\n`);
    expect(parse(out).daemon?.hook_binary).toBe(BIN);
  });

  test("an existing [daemon] table gains the key right after its header", () => {
    const before = [
      "# my config",
      "[daemon]",
      'socket = "~/.jev-cops/copsd.sock" # agent socket',
      "",
      "[judge]",
      'provider = "mock"',
      "",
    ].join("\n");
    const out = setDaemonHookBinary(before, BIN);
    expect(out).toBe(before.replace("[daemon]\n", `[daemon]\nhook_binary = "${BIN}"\n`));
    expect(parse(out)).toEqual({
      daemon: { socket: "~/.jev-cops/copsd.sock", hook_binary: BIN },
      judge: { provider: "mock" },
    });
  });

  test("an existing key is replaced in place (round trip keeps the other keys)", () => {
    const before = '[judge]\nprovider = "off"\n\n[daemon]\nhook_binary = "/old"\nhttp = false\n';
    const out = setDaemonHookBinary(before, BIN);
    expect(out).toBe(before.replace('"/old"', `"${BIN}"`));
    expect(parse(out)).toEqual({
      judge: { provider: "off" },
      daemon: { hook_binary: BIN, http: false },
    });
  });

  test("a key of the same name in another table is left alone", () => {
    const before = '[other]\nhook_binary = "/keep"\n';
    const out = setDaemonHookBinary(before, BIN);
    expect(parse(out)).toEqual({ other: { hook_binary: "/keep" }, daemon: { hook_binary: BIN } });
  });

  test("a file without a trailing newline", () => {
    expect(setDaemonHookBinary('[judge]\nprovider = "off"', BIN)).toBe(
      `[judge]\nprovider = "off"\n\n[daemon]\nhook_binary = "${BIN}"\n`,
    );
  });

  test("quotes and backslashes are escaped", () => {
    const odd = '/opt/a "b"\\c/cops-hook';
    expect(parse(setDaemonHookBinary(null, odd)).daemon?.hook_binary).toBe(odd);
  });

  test.each([
    ["a dotted key", 'daemon.hook_binary = "/old"\n'],
    ["an inline table", 'daemon = { socket = "/s" }\n'],
    ["an unclosed header", "[daemon\n"],
    ["invalid TOML", "= = =\n"],
  ])("refuses to guess with %s", (_name, before) => {
    expect(() => setDaemonHookBinary(before, BIN)).toThrow("edit it by hand");
  });

  test("refuses a path with a newline", () => {
    expect(() => setDaemonHookBinary(null, "/a\nb")).toThrow();
  });
});

describe("readDaemonHookBinary", () => {
  test("the key, or null for no file, no key, another type, invalid TOML", () => {
    expect(readDaemonHookBinary(`[daemon]\nhook_binary = "${BIN}"\n`)).toBe(BIN);
    expect(readDaemonHookBinary(null)).toBeNull();
    expect(readDaemonHookBinary('[judge]\nprovider = "off"\n')).toBeNull();
    expect(readDaemonHookBinary("[daemon]\nhook_binary = 3\n")).toBeNull();
    expect(readDaemonHookBinary("= = =")).toBeNull();
  });
});

describe("unsetDaemonHookBinary: uninstall takes back exactly what install added", () => {
  test.each([
    ["no file (install created it)", null],
    [
      "the e2e's cops.toml (no [daemon] table)",
      '[enforcement]\nmode = "enforce"\n\n[audit.forward]\nkind = "syslog"\n',
    ],
    [
      "a [daemon] table with keys of its own",
      '# mine\n[daemon]\nsocket = "/s" # agent\n\n[judge]\nprovider = "off"\n',
    ],
    [
      "a [daemon] table last in the file",
      '[judge]\nprovider = "off"\n[daemon]\nhttp = "127.0.0.1:1"\n',
    ],
  ])("set then unset is byte-identical: %s", (_name, before) => {
    const installed = setDaemonHookBinary(before, BIN);
    expect(unsetDaemonHookBinary(installed, BIN)).toBe(before ?? "");
  });

  test("only the value it was asked to remove", () => {
    const text = `[daemon]\nhook_binary = "${BIN}"\n`;
    expect(unsetDaemonHookBinary(text, "/other/cops-hook")).toBe(text);
    expect(unsetDaemonHookBinary('[judge]\nprovider = "off"\n', BIN)).toBe(
      '[judge]\nprovider = "off"\n',
    );
    expect(unsetDaemonHookBinary(null, BIN)).toBeNull();
  });

  test("a [daemon] table with a comment keeps its header", () => {
    const text = `[daemon]\n# the hook\nhook_binary = "${BIN}"\n`;
    expect(unsetDaemonHookBinary(text, BIN)).toBe("[daemon]\n# the hook\n");
  });

  test("a file it cannot edit safely is left alone", () => {
    const dotted = `daemon.hook_binary = "${BIN}"\n`;
    expect(unsetDaemonHookBinary(dotted, BIN)).toBe(dotted);
    expect(unsetDaemonHookBinary("= = =", BIN)).toBe("= = =");
  });
});
