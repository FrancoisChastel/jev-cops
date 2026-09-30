import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GuardedFs, guardedFs, isUnder } from "../testing/fs-guard.ts";
import { CLAUDE_CODE_GAPS } from "./gaps.ts";
import { INSTALLED_EVENTS } from "./hook-entries.ts";
import { selfOf } from "./hook-identity.ts";
import {
  InstallError,
  type InstallOptions,
  installClaudeCodeHooks,
  readView,
  restoreSettings,
  uninstallClaudeCodeHooks,
} from "./install.ts";
import { checkIntact } from "./intact.ts";
import { MANAGED_DROP_IN } from "./settings.ts";

let root = "";
let home = "";
let project = "";
let managed = "";
let bin = "";
let fs: GuardedFs;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-inst-")));
  home = join(root, "home");
  project = join(root, "project");
  managed = join(root, "managed");
  for (const d of [home, project, managed, join(root, "bin")]) mkdirSync(d);
  bin = join(root, "bin", "cops-hook");
  writeFileSync(bin, "#!/bin/sh\nexit 2\n");
  chmodSync(bin, 0o755);
  fs = guardedFs([root]);
});
afterEach(() => {
  for (const p of fs.written) expect(isUnder(p, [root])).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

type Json = Record<string, unknown>;
const NOW = new Date("2026-09-29T09:12:00.000Z");
const opts = (over: Partial<InstallOptions> = {}): InstallOptions => ({
  scope: "user",
  home,
  projectDir: project,
  configDir: null,
  managedDir: managed,
  hookBinary: bin,
  socket: join(root, "d.sock"),
  transport: "command",
  httpUrl: null,
  pathEnv: "/usr/bin:/bin",
  fs,
  now: () => NOW,
  ...over,
});
const userFile = () => join(home, ".claude", "settings.json");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Json;
const mode = (p: string) => statSync(p).mode & 0o777;
const LINT = { type: "command", command: "/usr/bin/lint", args: [] };

function writeJson(path: string, value: Json): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}

describe("installClaudeCodeHooks: scopes", () => {
  test("user: creates ~/.claude/settings.json (0600, dir 0700) with every event", () => {
    const r = installClaudeCodeHooks(opts());
    expect(r).toMatchObject({ status: "installed", changed: true, written: true, backup: null });
    expect(r.path).toBe(userFile());
    expect(Object.keys(read(r.path).hooks as Json)).toEqual([...INSTALLED_EVENTS]);
    expect(mode(r.path)).toBe(0o600);
    expect(mode(join(home, ".claude"))).toBe(0o700);
    expect(r.gaps).toBe(CLAUDE_CODE_GAPS);
  });

  test("user under CLAUDE_CONFIG_DIR", () => {
    const configDir = join(home, "cfg");
    expect(installClaudeCodeHooks(opts({ configDir })).path).toBe(join(configDir, "settings.json"));
  });

  test("project (0644) and local (0600)", () => {
    const p = installClaudeCodeHooks(opts({ scope: "project" }));
    expect(p.path).toBe(join(project, ".claude", "settings.json"));
    expect(mode(p.path)).toBe(0o644);
    const l = installClaudeCodeHooks(opts({ scope: "local" }));
    expect(l.path).toBe(join(project, ".claude", "settings.local.json"));
    expect(mode(l.path)).toBe(0o600);
  });

  test("managed as root: a drop-in under managed-settings.d (0644)", () => {
    const r = installClaudeCodeHooks(opts({ scope: "managed", isRoot: true }));
    expect(r.path).toBe(join(managed, "managed-settings.d", MANAGED_DROP_IN));
    expect(r.status).toBe("installed");
    expect(mode(r.path)).toBe(0o644);
  });

  test("managed without root: the JSON is printed, nothing is written (never sudo)", () => {
    const r = installClaudeCodeHooks(opts({ scope: "managed", isRoot: false }));
    expect(r).toMatchObject({ status: "printed", written: false });
    expect(JSON.parse(r.after ?? "")).toHaveProperty("hooks.PreToolUse");
    expect(existsSync(join(managed, "managed-settings.d"))).toBe(false);
  });

  test("managed with --force and no root tries the write (and says why it failed)", () => {
    const denied: GuardedFs = {
      ...fs,
      mkdirp: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };
    const run = () => installClaudeCodeHooks(opts({ scope: "managed", force: true, fs: denied }));
    expect(run).toThrow(InstallError);
    expect(run).toThrow("EACCES");
  });
});

describe("installClaudeCodeHooks: merge, backup, idempotence", () => {
  test("merges into a file with foreign hooks, keeps its keys, backs it up", () => {
    const original = writeJson(userFile(), {
      model: "opus",
      hooks: { Stop: [{ hooks: [LINT] }] },
      permissions: { allow: ["Read"] },
    });
    const r = installClaudeCodeHooks(opts());
    expect(r.backup).toBe(`${userFile()}.jev-cops-20260929T091200000Z.bak`);
    expect(readFileSync(r.backup ?? "", "utf8")).toBe(original);
    const after = read(r.path);
    expect(Object.keys(after)).toEqual(["model", "hooks", "permissions"]);
    expect((after.hooks as Json).Stop).toEqual([{ hooks: [LINT] }]);
    expect(r.before).toBe(original);
    expect(r.diff).toContain('+    "PreToolUse": [');
  });

  test("a second install is a no-op: unchanged, no write, no backup", () => {
    installClaudeCodeHooks(opts());
    const text = readFileSync(userFile(), "utf8");
    const again = installClaudeCodeHooks(opts());
    expect(again).toMatchObject({ status: "unchanged", changed: false, written: false, diff: "" });
    expect(readFileSync(userFile(), "utf8")).toBe(text);
    expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  test("dry-run: the diff, and nothing written", () => {
    const r = installClaudeCodeHooks(opts({ dryRun: true }));
    expect(r).toMatchObject({ status: "dry-run", written: false, changed: true });
    expect(r.diff.startsWith(`--- ${userFile()} (absent)`)).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("the installed entries pass the ConfigChange intact check (D-087 is the contract)", () => {
    const r = installClaudeCodeHooks(opts());
    const view = readView(opts(), fs);
    // The identity the registered binary computes for itself when it runs (compiled).
    const id = {
      ...selfOf([], { execPath: bin, main: "/$bunfs/root/cops-hook" }),
      socket: join(root, "d.sock"),
      home,
      projectDir: project,
      path: "",
    };
    expect(checkIntact(view.files, id, r.path)).toMatchObject({ intact: true });
    expect(r.warnings.some((w) => w.includes("intact"))).toBe(false);
  });

  test("--transport http entries are intact for a hook started with --http-url", () => {
    const httpUrl = "http://127.0.0.1:8787";
    const r = installClaudeCodeHooks(opts({ transport: "http", httpUrl }));
    const hooks = read(r.path).hooks as Record<string, Json[]>;
    expect(hooks.PostToolUse?.[0]).toEqual({
      hooks: [{ type: "http", url: `${httpUrl}/v1/hooks/claude-code`, timeout: 15 }],
    });
    const id = {
      ...selfOf([], { execPath: bin, main: "/$bunfs/root/cops-hook" }),
      socket: join(root, "d.sock"),
      home,
      projectDir: project,
      path: "",
      httpUrl,
    };
    expect(checkIntact(readView(opts(), fs).files, id).intact).toBe(true);
  });

  test("an invalid target file or hooks shape is an InstallError; the file is untouched", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(userFile(), '{"hooks": {},}');
    expect(() => installClaudeCodeHooks(opts())).toThrow(InstallError);
    writeFileSync(userFile(), '{"hooks": []}');
    expect(() => installClaudeCodeHooks(opts())).toThrow("`hooks` is not an object");
    expect(readFileSync(userFile(), "utf8")).toBe('{"hooks": []}');
  });
});

describe("installClaudeCodeHooks: refusals and --force", () => {
  test("a bare Bash allow refuses; nothing is written", () => {
    writeJson(join(project, ".claude", "settings.local.json"), {
      permissions: { allow: ["Bash"] },
    });
    const r = installClaudeCodeHooks(opts());
    expect(r.status).toBe("refused");
    expect(r.refused[0]).toContain('"Bash"');
    expect(existsSync(userFile())).toBe(false);
  });

  test("--force installs anyway, warns loudly and records the gap", () => {
    writeJson(userFile(), { permissions: { allow: ["Bash"] } });
    const r = installClaudeCodeHooks(opts({ force: true }));
    expect(r.status).toBe("installed");
    expect(r.forced).toHaveLength(1);
    expect(r.warnings.some((w) => w.startsWith("FORCED:") && w.includes('"Bash"'))).toBe(true);
  });

  test("forcing past disableAllHooks warns that the hook would not be intact", () => {
    writeJson(join(project, ".claude", "settings.json"), { disableAllHooks: true });
    expect(installClaudeCodeHooks(opts()).status).toBe("refused");
    const r = installClaudeCodeHooks(opts({ force: true }));
    expect(r.warnings.some((w) => w.includes("would not find the cops hook intact"))).toBe(true);
  });

  test("--transport http without the daemon's HTTP bind cannot be forced", () => {
    const r = installClaudeCodeHooks(opts({ transport: "http", force: true }));
    expect(r.status).toBe("refused");
    expect(r.refused[0]).toContain("[daemon] http");
  });

  test("warnings: untrusted folder, --dangerously-skip-permissions, no OpenShell", () => {
    const w = installClaudeCodeHooks(opts()).warnings;
    expect(w.some((l) => l.includes("workspace trust"))).toBe(true);
    expect(w.some((l) => l.includes("--dangerously-skip-permissions"))).toBe(true);
    expect(w.some((l) => l.includes("Without OpenShell"))).toBe(true);
  });

  test("a trusted folder in ~/.claude.json silences the trust warning", () => {
    writeJson(join(home, ".claude.json"), {
      projects: { [project]: { hasTrustDialogAccepted: true } },
    });
    const w = installClaudeCodeHooks(opts()).warnings;
    expect(w.some((l) => l.includes("workspace trust"))).toBe(false);
  });
});

describe("uninstallClaudeCodeHooks", () => {
  test("removes only jev-cops's groups: foreign hooks come back byte-identical", () => {
    const original = writeJson(userFile(), { hooks: { PreToolUse: [{ hooks: [LINT] }] }, x: 1 });
    installClaudeCodeHooks(opts());
    const r = uninstallClaudeCodeHooks(opts());
    expect(r).toMatchObject({ status: "uninstalled", written: true });
    expect(readFileSync(userFile(), "utf8")).toBe(original);
    expect(r.backup).not.toBeNull();
  });

  test("a file left empty is removed (its backup stays)", () => {
    installClaudeCodeHooks(opts());
    const r = uninstallClaudeCodeHooks(opts());
    expect(existsSync(userFile())).toBe(false);
    expect(r.after).toBeNull();
    expect(readFileSync(r.backup ?? "", "utf8")).toContain("cops-hook");
  });

  test("nothing installed: absent, nothing written", () => {
    expect(uninstallClaudeCodeHooks(opts())).toMatchObject({ status: "absent", written: false });
    writeJson(userFile(), { x: 1 });
    expect(uninstallClaudeCodeHooks(opts())).toMatchObject({ status: "absent", written: false });
  });

  test("dry-run and managed without root write nothing", () => {
    installClaudeCodeHooks(opts());
    expect(uninstallClaudeCodeHooks(opts({ dryRun: true })).status).toBe("dry-run");
    expect(existsSync(userFile())).toBe(true);
    installClaudeCodeHooks(opts({ scope: "managed", isRoot: true }));
    const m = uninstallClaudeCodeHooks(opts({ scope: "managed", isRoot: false }));
    expect(m.status).toBe("printed");
    expect(existsSync(m.path)).toBe(true);
  });
});

describe("restoreSettings (canary rollback)", () => {
  test("puts the previous file back", () => {
    const original = writeJson(userFile(), { x: 1 });
    const r = installClaudeCodeHooks(opts());
    restoreSettings(r, { fs, now: () => NOW });
    expect(readFileSync(userFile(), "utf8")).toBe(original);
  });

  test("removes a file the install created; ignores an install that wrote nothing", () => {
    const r = installClaudeCodeHooks(opts());
    restoreSettings(r, { fs, now: () => NOW });
    expect(existsSync(userFile())).toBe(false);
    restoreSettings({ ...r, written: false }, { fs, now: () => NOW });
  });
});

describe("the test guard", () => {
  test("a write outside the temp dirs throws before touching disk", () => {
    const outside = join(tmpdir(), "jev-cops-escape-check", "settings.json");
    expect(() => fs.writeFile(outside, "{}", 0o600)).toThrow("escaped its temp dirs");
    expect(existsSync(outside)).toBe(false);
  });
});
