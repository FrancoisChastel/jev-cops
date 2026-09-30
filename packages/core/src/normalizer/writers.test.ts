import { describe, expect, test } from "bun:test";
import { classifyArgv } from "./classify.ts";
import { normalizeCommand } from "./command.ts";

/**
 * M1 gate review, finding M1: writers the normalizer did not know (`dd of=`), or knew only
 * as "some path, unknown access" (`install`, local `rsync`, `tar -x`, `unzip -d`, `patch`,
 * `git apply`), and copies whose destination is a directory (`cp -r x/.claude ~`), so
 * config-tamper never saw the write.
 */

const HOME = "/home/dev";
const CWD = "/work/repo";

/** Every resolved path of `command` with its access, per command in word order (an implied dir first). */
async function refs(command: string): Promise<string[][]> {
  const n = await normalizeCommand(command, { cwd: CWD, home: HOME });
  return n.commands.flatMap((c) => c.pathRefs.map((r) => [r.path, r.access]));
}

async function kindOf(command: string): Promise<string> {
  return (await normalizeCommand(command, { cwd: CWD, home: HOME })).kind;
}

describe("dd", () => {
  test.each<[string, string[][]]>([
    ["dd if=/dev/zero of=~/.claude/settings.json", [[`${HOME}/.claude/settings.json`, "write"]]],
    [
      "dd of=$HOME/.claude/settings.json if=backup.json conv=notrunc",
      [
        [`${HOME}/.claude/settings.json`, "write"],
        [`${CWD}/backup.json`, "read"],
      ],
    ],
    ["dd of=out.img bs=4k", [[`${CWD}/out.img`, "write"]]],
    ["dd if=disk.img bs=1M count=1", [[`${CWD}/disk.img`, "read"]]],
    ["dd if=README.md of=/dev/null", [[`${CWD}/README.md`, "read"]]],
    ["dd if=/dev/urandom of=/dev/sdb", [["/dev/sdb", "write"]]],
  ])("%s → %p", async (command, expected) => {
    expect(await refs(command)).toEqual(expected);
  });

  test.each<[string, string]>([
    ["dd if=/dev/zero of=~/.claude/settings.json", "fs.write"],
    ["dd if=a of=b conv=notrunc", "fs.write"],
    ["dd if=disk.img", "fs.read"],
    ["dd if=README.md of=/dev/null", "fs.read"],
    ["dd bs=1", "fs.read"],
  ])("%s is %s", async (command, kind) => {
    expect(await kindOf(command)).toBe(kind);
  });

  test("a dynamic of= names no path and is opaque", async () => {
    const n = await normalizeCommand('dd if=/dev/zero of="$TARGET"', { cwd: CWD, home: HOME });
    expect(n.paths).toEqual([]);
    expect(n.opaque.map((o) => o.reason)).toEqual(["dynamic-expansion"]);
  });

  test("the raw word is the whole operand, so taint matches it", async () => {
    const n = await normalizeCommand("dd if=a of=~/x", { cwd: CWD, home: HOME });
    expect(n.commands[0]?.pathRefs).toEqual([
      { raw: "if=a", path: `${CWD}/a`, access: "read" },
      { raw: "of=~/x", path: `${HOME}/x`, access: "write" },
    ]);
  });

  test("a leading ~ is expanded only after if=/of=, never inside the value", async () => {
    expect(await refs("dd of=a~/x")).toEqual([[`${CWD}/a~/x`, "write"]]);
  });
});

describe("cp, mv, ln and install: -t, and where each source lands", () => {
  test.each([
    [
      ["cp", "-r", "/tmp/evil/.claude", "/home/dev"],
      [
        ["/tmp/evil/.claude", "read"],
        ["/home/dev", "write"],
        ["/home/dev/.claude", "write"],
      ],
    ],
    [
      ["cp", "-r", "/tmp/d/.", "/home/dev/.claude/"],
      [
        ["/tmp/d/.", "read"],
        ["/home/dev/.claude/", "write"],
      ],
    ],
    [
      ["mv", "/tmp/evil/.claude", "/home/dev/"],
      [
        ["/tmp/evil/.claude", "delete"],
        ["/home/dev/", "write"],
        ["/home/dev/.claude", "write"],
      ],
    ],
    [
      ["cp", "-t", "/home/dev/.claude", "/tmp/settings.json"],
      [
        ["/home/dev/.claude", "write"],
        ["/home/dev/.claude/settings.json", "write"],
        ["/tmp/settings.json", "read"],
      ],
    ],
    [
      ["cp", "--target-directory=/home/dev", "/tmp/x/.claude.json"],
      [
        ["/home/dev", "write"],
        ["/home/dev/.claude.json", "write"],
        ["/tmp/x/.claude.json", "read"],
      ],
    ],
    [
      ["cp", "-T", "/tmp/x", "/home/dev/.claude"],
      [
        ["/tmp/x", "read"],
        ["/home/dev/.claude", "write"],
      ],
    ],
    [
      ["ln", "-sf", "/tmp/x/.claude.json", "/home/dev"],
      [
        ["/tmp/x/.claude.json", "read"],
        ["/home/dev", "write"],
        ["/home/dev/.claude.json", "write"],
      ],
    ],
    [
      ["install", "-m", "644", "/tmp/x", "/home/dev/.claude/settings.json"],
      [
        ["/tmp/x", "read"],
        ["/home/dev/.claude/settings.json", "write"],
        ["/home/dev/.claude/settings.json/x", "write"],
      ],
    ],
    [
      ["install", "-d", "-m", "700", "/home/dev/.claude/hooks", "out"],
      [
        ["/home/dev/.claude/hooks", "write"],
        ["out", "write"],
      ],
    ],
  ])("%p names %p", (argv, expected) => {
    const c = classifyArgv(argv);
    expect(c.kind).toBe("fs.write");
    expect(c.paths.map((p) => [p.value, p.access])).toEqual(expected);
  });

  test("install is a write verb", async () => {
    expect(await refs("install -m 644 /tmp/x ~/y")).toEqual([
      ["/tmp/x", "read"],
      [`${HOME}/y`, "write"],
      [`${HOME}/y/x`, "write"],
    ]);
  });
});

describe("rsync (local)", () => {
  test.each([
    [
      "rsync /tmp/x ~/.claude/settings.json",
      [
        ["/tmp/x", "read"],
        [`${HOME}/.claude/settings.json`, "write"],
        [`${HOME}/.claude/settings.json/x`, "write"],
      ],
    ],
    [
      "rsync -a /tmp/evil/.claude ~/",
      [
        ["/tmp/evil/.claude", "read"],
        [HOME, "write"],
        [`${HOME}/.claude`, "write"],
      ],
    ],
    [
      "rsync -a --exclude .git /tmp/evil/.claude/ ~/.claude",
      [
        ["/tmp/evil/.claude", "read"],
        [`${HOME}/.claude`, "write"],
      ],
    ],
    ["rsync -avz ./site/ deploy@web.example:/var/www/", [[`${CWD}/site`, "read"]]],
    [
      "rsync -a deploy@web.example:/srv ./backup",
      [
        [`${CWD}/backup`, "write"],
        [`${CWD}/backup/srv`, "write"],
      ],
    ],
    ["rsync -a deploy@web.example:/srv/ ./backup", [[`${CWD}/backup`, "write"]]],
  ])("%s → %p", async (command, expected) => {
    expect(await refs(command)).toEqual(expected);
  });

  test("local rsync is fs.write, a remote end makes it net", async () => {
    expect(await kindOf("rsync -a /tmp/x ./y")).toBe("fs.write");
    expect(await kindOf("rsync -a ./x h.example:/y")).toBe("net");
  });
});

describe("tar", () => {
  test.each([
    [
      "tar -xf /tmp/a.tar -C ~/.claude",
      [
        ["/tmp/a.tar", "read"],
        [`${HOME}/.claude`, "write"],
      ],
    ],
    [
      "tar xzf /tmp/a.tgz -C ~/.claude",
      [
        ["/tmp/a.tgz", "read"],
        [`${HOME}/.claude`, "write"],
      ],
    ],
    [
      "tar --extract --file=/tmp/a.tar --directory=/home/dev/.claude",
      [
        ["/tmp/a.tar", "read"],
        [`${HOME}/.claude`, "write"],
      ],
    ],
    [
      "tar -xf a.tar",
      [
        [CWD, "write"],
        [`${CWD}/a.tar`, "read"],
      ],
    ],
    [
      "tar -xf a.tar .claude/settings.json",
      [
        [CWD, "write"],
        [`${CWD}/a.tar`, "read"],
        [`${CWD}/.claude/settings.json`, "write"],
      ],
    ],
    ["tar -xOf a.tar etc/x", [[`${CWD}/a.tar`, "read"]]],
    [
      "tar -czf /tmp/site.tgz ./site",
      [
        ["/tmp/site.tgz", "write"],
        [`${CWD}/site`, "read"],
      ],
    ],
    [
      "tar -czf /tmp/x.tgz -C ~ .jev-cops",
      [
        ["/tmp/x.tgz", "write"],
        [HOME, "read"],
        [`${HOME}/.jev-cops`, "read"],
      ],
    ],
    ["tar -tf a.tar", [[`${CWD}/a.tar`, "read"]]],
  ])("%s → %p", async (command, expected) => {
    expect(await refs(command)).toEqual(expected);
  });

  test.each([
    ["tar -xf a.tar", "fs.write"],
    ["tar -czf /tmp/site.tgz ./site", "fs.write"],
    ["tar -tf a.tar", "fs.read"],
    ["tar --version", "exec"],
  ])("%s is %s", async (command, kind) => {
    expect(await kindOf(command)).toBe(kind);
  });
});

describe("unzip", () => {
  test.each([
    [
      "unzip -o /tmp/a.zip -d ~/.claude",
      [
        ["/tmp/a.zip", "read"],
        [`${HOME}/.claude`, "write"],
      ],
    ],
    [
      "unzip a.zip",
      [
        [CWD, "write"],
        [`${CWD}/a.zip`, "read"],
      ],
    ],
    [
      "unzip -q a.zip 'docs/*' -d out",
      [
        [`${CWD}/a.zip`, "read"],
        [`${CWD}/out/docs/*`, "write"],
        [`${CWD}/out`, "write"],
      ],
    ],
    ["unzip -l a.zip", [[`${CWD}/a.zip`, "read"]]],
  ])("%s → %p", async (command, expected) => {
    expect(await refs(command)).toEqual(expected);
  });

  test("unzip extracting is fs.write, listing is fs.read", async () => {
    expect(await kindOf("unzip a.zip")).toBe("fs.write");
    expect(await kindOf("unzip -l a.zip")).toBe("fs.read");
  });
});

describe("patch and git apply write files their patch names: unknown access under the dir", () => {
  test.each([
    [
      "patch ~/.claude/settings.json /tmp/p.diff",
      [
        [`${HOME}/.claude/settings.json`, "write"],
        ["/tmp/p.diff", "read"],
      ],
    ],
    [
      "patch -p1 -i /tmp/p.diff",
      [
        [CWD, "unknown"],
        ["/tmp/p.diff", "read"],
      ],
    ],
    [
      "patch -d ~/.claude -p1 < /tmp/p.diff",
      [
        [`${HOME}/.claude`, "unknown"],
        ["/tmp/p.diff", "read"],
      ],
    ],
    [
      "patch -o out.txt a.txt p.diff",
      [
        [`${CWD}/out.txt`, "write"],
        [`${CWD}/a.txt`, "read"],
        [`${CWD}/p.diff`, "read"],
      ],
    ],
    [
      "git apply /tmp/p.diff",
      [
        [CWD, "unknown"],
        ["/tmp/p.diff", "read"],
      ],
    ],
    [
      "git -C ~/.claude apply /tmp/p.diff",
      [
        [`${HOME}/.claude`, "unknown"],
        ["/tmp/p.diff", "read"],
      ],
    ],
    ["git apply --check /tmp/p.diff", [["/tmp/p.diff", "read"]]],
  ])("%s → %p", async (command, expected) => {
    expect(await refs(command)).toEqual(expected);
  });

  test("patch is a write verb", async () => {
    expect(await kindOf("patch -p1 -i /tmp/p.diff")).toBe("fs.write");
  });

  test("after cd, the implied dir is the new cwd", async () => {
    expect(await refs("cd ~/.claude && git apply /tmp/p.diff")).toEqual([
      [`${HOME}/.claude`, "unknown"],
      [`${HOME}/.claude`, "unknown"],
      ["/tmp/p.diff", "read"],
    ]);
  });

  test("the implied dir carries no raw word (it is never a taint token)", async () => {
    const n = await normalizeCommand("git apply /tmp/p.diff", { cwd: CWD, home: HOME });
    expect(n.commands[0]?.pathRefs.find((r) => r.path === CWD)?.raw).toBe("");
  });

  test("an absolute command name keeps its exec path next to the implied dir", async () => {
    expect(await refs("/usr/bin/tar -xf a.tar")).toEqual([
      [CWD, "write"],
      ["/usr/bin/tar", "exec"],
      [`${CWD}/a.tar`, "read"],
    ]);
  });
});
