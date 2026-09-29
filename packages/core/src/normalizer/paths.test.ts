import { describe, expect, test } from "bun:test";
import { absolutize, expandHome, looksLikePath, resolvePath } from "./paths.ts";

const HOME = "/home/dev";
const CWD = "/work/repo";

describe("expandHome", () => {
  test.each([
    ["~", HOME],
    ["~/", `${HOME}/`],
    ["~/.ssh/id_rsa", `${HOME}/.ssh/id_rsa`],
    ["$HOME", HOME],
    ["$HOME/.aws/credentials", `${HOME}/.aws/credentials`],
    ["${HOME}", HOME],
    ["${HOME}/x", `${HOME}/x`],
  ])("expands %p", (word, expected) => {
    expect(expandHome(word, HOME)).toBe(expected);
  });

  test.each(["~root/x", "$HOMEDIR/x", "${HOMEX}", "a/~/b", "./$HOME", "", "/etc/passwd"])(
    "leaves %p unchanged",
    (word) => {
      expect(expandHome(word, HOME)).toBe(word);
    },
  );
});

describe("absolutize", () => {
  test.each([
    ["x", `${CWD}/x`],
    ["./x", `${CWD}/x`],
    ["../other/x", "/work/other/x"],
    ["a/./b/../c", `${CWD}/a/c`],
    ["a//b///c/", `${CWD}/a/b/c`],
    [".", CWD],
    ["/etc/../etc//passwd", "/etc/passwd"],
    ["/", "/"],
    ["../../../../..", "/"],
  ])("resolves %p against the cwd", (word, expected) => {
    expect(absolutize(word, CWD)).toBe(expected);
  });

  test.each(["", "~root/x", "~"])("returns null for the unresolvable %p", (word) => {
    expect(absolutize(word, CWD)).toBeNull();
  });
});

describe("resolvePath", () => {
  test("expands home, then resolves", () => {
    expect(resolvePath("~/.ssh/../.ssh/id_rsa", CWD, HOME)).toBe(`${HOME}/.ssh/id_rsa`);
    expect(resolvePath("$HOME/x", CWD, HOME)).toBe(`${HOME}/x`);
  });

  test("resolves a relative path against the cwd", () => {
    expect(resolvePath("src/../.env", CWD, HOME)).toBe(`${CWD}/.env`);
  });
});

describe("looksLikePath", () => {
  test.each(["/etc", "./x", "../x", "~", "~/x", "$HOME/x", "${HOME}", ".", ".."])(
    "is true for %p",
    (word) => {
      expect(looksLikePath(word)).toBe(true);
    },
  );

  test.each(["x", "-rf", "https://h/x", "node_modules", "a/b", ""])("is false for %p", (word) => {
    expect(looksLikePath(word)).toBe(false);
  });
});
