import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_CONFIG } from "./config.ts";
import { findSecretPatterns, globToRegExp, isSecretPath, SECRET_PATTERNS } from "./secrets.ts";

const HOME = "/home/dev";
const GLOBS = DEFAULT_CONTEXT_CONFIG.secrets.pathGlobs;

describe("isSecretPath: spec globs", () => {
  test.each([
    "/work/repo/.env",
    "/work/repo/.env.local",
    "/work/repo/a/b/.envrc",
    "/work/repo/.env-prod",
    "/.env",
    "/work/repo/certs/server.pem",
    "/etc/ssl/private/site.key",
    "/home/dev/.ssh/id_rsa",
    "/home/dev/.ssh",
    "/home/dev/.ssh/keys/deploy",
    "/home/dev/.aws/credentials",
    "/work/repo/.ENV",
  ])("%s is a secret path", (path) => {
    expect(isSecretPath(path, HOME, GLOBS)).toBe(true);
  });

  test.each([
    "/work/repo/.environment.md",
    "/work/repo/src/keyboard.ts",
    "/work/repo/docs/env.md",
    "/work/repo/key",
    "/work/repo/pem.ts",
    "/other/.ssh/id_rsa",
    "/home/dev/.sshrc",
    "/home/dev/.aws-notes",
  ])("%s is not a secret path", (path) => {
    expect(isSecretPath(path, HOME, GLOBS)).toBe(false);
  });

  test("uses the default globs when none are given", () => {
    expect(isSecretPath("/x/.env", HOME)).toBe(true);
  });

  test("~ expands to the given home, not the daemon's", () => {
    expect(isSecretPath("/root/.ssh/id_rsa", "/root", GLOBS)).toBe(true);
    expect(isSecretPath("/root/.ssh/id_rsa", HOME, GLOBS)).toBe(false);
  });
});

describe("globToRegExp", () => {
  test("* stays inside one segment, ** crosses segments", () => {
    expect(globToRegExp("/a/*.ts", HOME).test("/a/b.ts")).toBe(true);
    expect(globToRegExp("/a/*.ts", HOME).test("/a/b/c.ts")).toBe(false);
    expect(globToRegExp("/a/**/c.ts", HOME).test("/a/b/d/c.ts")).toBe(true);
    expect(globToRegExp("/a/**/c.ts", HOME).test("/a/c.ts")).toBe(true);
  });

  test("regex metacharacters in the glob and in home are literal", () => {
    expect(globToRegExp("~/a+b/(x).txt", "/h.o").test("/h.o/a+b/(x).txt")).toBe(true);
    expect(globToRegExp("~/a+b/(x).txt", "/h.o").test("/hxo/a+b/(x).txt")).toBe(false);
    expect(globToRegExp("~/.ssh/**", "/h*").test("/hxx/.ssh/id")).toBe(false);
  });

  test("{a,b} alternatives and ? single character", () => {
    const re = globToRegExp("/x/{foo,ba?}.md", HOME);
    expect(re.test("/x/foo.md")).toBe(true);
    expect(re.test("/x/bar.md")).toBe(true);
    expect(re.test("/x/baz/.md")).toBe(false);
  });
});

describe("findSecretPatterns: content in stdout_head", () => {
  const cases: [string, string][] = [
    ["aws-access-key", `aws_access_key_id = AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["private-key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn..."],
    ["private-key", "-----BEGIN PRIVATE KEY-----"],
    ["github-token", `token: ghp_${"a".repeat(36)}`],
    ["slack-token", `SLACK=${"xoxb"}-1234-abcd`],
    ["generic-secret", "API_KEY=0123456789abcdef"],
    ["generic-secret", 'password: "hunter2hunter2"'],
    ["jwt", `Authorization: Bearer ${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxIn0"}.sig`],
  ];

  test.each(cases)("detects %s", (name, text) => {
    expect(findSecretPatterns(text)).toContain(name);
  });

  test("returns pattern names only, never the matched secret", () => {
    const secret = `ghp_${"b".repeat(36)}`;
    const found = findSecretPatterns(`here: ${secret}`);
    expect(found).toEqual(["github-token"]);
    expect(found.join(" ")).not.toContain(secret);
  });

  test("returns [] for ordinary output", () => {
    expect(findSecretPatterns("PASS auth/session.test.ts (3 tests)\ntoken count: 12")).toEqual([]);
  });

  test("each name appears once even with repeated matches", () => {
    expect(findSecretPatterns("token=aaaaaaaaaa\nsecret=bbbbbbbbbb")).toEqual(["generic-secret"]);
  });

  test("the pattern table has the six spec patterns", () => {
    expect(SECRET_PATTERNS.map((p) => p.name)).toEqual([
      "aws-access-key",
      "private-key",
      "github-token",
      "slack-token",
      "generic-secret",
      "jwt",
    ]);
  });
});
