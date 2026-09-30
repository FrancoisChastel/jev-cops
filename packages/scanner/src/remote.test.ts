import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGitSource, GIT_CLONE_GUARD, isPrivateHost, remoteUrlProblem } from "./remote.ts";

let root: string;
let git: string;
let scanRoot: string;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A fake git: records argv and env, then acts as `mode` says (a file next to it). */
function fakeGit(mode: string): void {
  writeFileSync(join(root, "git.mode"), mode);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvremote-")));
  scanRoot = join(root, "scan");
  git = join(root, "git");
  writeFileSync(
    git,
    `#!/bin/sh
here="$(dirname "$0")"
{ printf '%s\\n' "$@"; echo "--end--"; } >> "$here/git.argv"
{ env; echo "--end--"; } >> "$here/git.env"
mode="$(cat "$here/git.mode")"
for a in "$@"; do last="$a"; done
case "$*" in
  *" clone "*)
    case "$mode" in
      fail) echo "fatal: repository 'https://example.com/x/' not found" >&2; exit 128 ;;
      hang) sleep 30 ;;
      big) mkdir -p "$last" && head -c 3000 /dev/zero > "$last/blob" ;;
      *) mkdir -p "$last/.git" "$last/scripts" && echo "---" > "$last/SKILL.md" && echo x > "$last/scripts/a.py" ;;
    esac ;;
  *"rev-parse"*)
    if [ "$mode" = badsha ]; then echo "not a sha"; else echo ${COMMIT}; fi ;;
esac
`,
  );
  chmodSync(git, 0o755);
  fakeGit("ok");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Every call's argv (or env), oldest first. */
function recorded(kind: "argv" | "env"): string[][] {
  const log = join(root, `git.${kind}`);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("--end--\n")
    .filter((block) => block !== "")
    .map((block) => block.split("\n").filter((l) => l !== ""));
}

const DAEMON_ENV = {
  PATH: "/usr/bin:relative:/bin",
  HOME: "/Users/me",
  GITHUB_TOKEN: "ghp_secret",
  GIT_DIR: "/elsewhere",
  HTTPS_PROXY: "http://proxy.corp:3128",
};

describe("fetchGitSource", () => {
  test("clones over https only, with every config hook off and no credentials, then pins the commit", async () => {
    const r = await fetchGitSource("https://github.com/o/skill.git", scanRoot, {
      git,
      env: DAEMON_ENV,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.commit).toBe(COMMIT);
    expect(readFileSync(join(r.value.dir, "SKILL.md"), "utf8")).toBe("---\n");
    const [clone, revParse] = recorded("argv");
    expect(clone).toEqual([
      ...GIT_CLONE_GUARD,
      "clone",
      "--depth",
      "1",
      "--no-tags",
      "--single-branch",
      "--no-recurse-submodules",
      "--",
      "https://github.com/o/skill.git",
      r.value.dir,
    ]);
    expect(revParse).toEqual([...GIT_CLONE_GUARD, "-C", r.value.dir, "rev-parse", "HEAD"]);
    expect(GIT_CLONE_GUARD).toContain("credential.helper=");
    const env = Object.fromEntries(
      (recorded("env")[0] ?? []).map((l) => [
        l.slice(0, l.indexOf("=")),
        l.slice(l.indexOf("=") + 1),
      ]),
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_NO_LAZY_FETCH: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      HTTPS_PROXY: "http://proxy.corp:3128",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.HOME).not.toBe("/Users/me");
    await r.value.cleanup();
    expect(readdirSync(scanRoot)).toEqual([]);
  });

  test.each([
    ["ssh://git@github.com/o/r.git", "only https sources are fetched (ssh:)"],
    ["git@github.com:o/r.git", "not an https URL"],
    ["http://github.com/o/r", "only https sources are fetched (http:)"],
    ["file:///tmp/r", "only https sources are fetched (file:)"],
    ["ext::sh -c touch% /tmp/pwned", "only https sources are fetched (ext:)"],
    ["https://user:pw@github.com/o/r", "credentials in the URL are refused"],
    ["https://localhost/o/r", "private host refused: localhost"],
    ["https://169.254.169.254/latest", "private host refused: 169.254.169.254"],
    ["https://2130706433/o/r", "private host refused: 127.0.0.1"],
    ["https://github.com/o/r/archive/main.zip", "zip downloads are not supported yet"],
  ])("%s → no fetch (%s)", async (url, why) => {
    expect(remoteUrlProblem(url)).toBe(why);
    const r = await fetchGitSource(url, scanRoot, { git, env: DAEMON_ENV });
    expect(r).toEqual({ ok: false, error: `remote source not fetched: ${why}` });
    expect(recorded("argv")).toEqual([]);
  });

  test("a failed clone: the error names git's last line, nothing is left behind", async () => {
    fakeGit("fail");
    const r = await fetchGitSource("https://example.com/x", scanRoot, { git, env: DAEMON_ENV });
    expect(r).toEqual({
      ok: false,
      error:
        "remote source not fetched: git clone exited 128: fatal: repository 'https://example.com/x/' not found",
    });
    expect(readdirSync(scanRoot)).toEqual([]);
  });

  test("over the size cap: refused and removed", async () => {
    fakeGit("big");
    const r = await fetchGitSource("https://example.com/x", scanRoot, {
      git,
      env: DAEMON_ENV,
      maxBytes: 1_000,
    });
    expect(r).toEqual({ ok: false, error: "remote source not fetched: over 1000 bytes" });
    expect(readdirSync(scanRoot)).toEqual([]);
  });

  test("a clone that hangs is killed at the deadline", async () => {
    fakeGit("hang");
    const r = await fetchGitSource("https://example.com/x", scanRoot, {
      git,
      env: DAEMON_ENV,
      deadlineMs: 300,
    });
    expect(r).toEqual({ ok: false, error: "remote source not fetched: git clone: timeout" });
  });

  test("no commit to pin is a failure", async () => {
    fakeGit("badsha");
    const r = await fetchGitSource("https://example.com/x", scanRoot, { git, env: DAEMON_ENV });
    expect(r).toEqual({ ok: false, error: "remote source not fetched: no commit to pin" });
  });

  test("git must be an absolute path; an unwritable root is an error", async () => {
    expect(await fetchGitSource("https://example.com/x", scanRoot, { git: "git" })).toEqual({
      ok: false,
      error: "remote source not fetched: git must be an absolute path",
    });
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "");
    const r = await fetchGitSource("https://example.com/x", join(blocker, "scan"), { git });
    expect(r.ok).toBe(false);
    expect(existsSync(join(blocker, "scan"))).toBe(false);
  });
});

describe("isPrivateHost", () => {
  test.each([
    ["localhost", true],
    ["api.localhost", true],
    ["printer.local", true],
    ["db.internal", true],
    ["intranet", true],
    ["10.1.2.3", true],
    ["127.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.0.10", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["[::1]", true],
    ["[2606:4700::1111]", true],
    ["github.com", false],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
  ])("%s → %p", (host, isPrivate) => {
    expect(isPrivateHost(host)).toBe(isPrivate);
  });
});
