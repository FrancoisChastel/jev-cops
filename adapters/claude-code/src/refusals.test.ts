import { describe, expect, test } from "bun:test";
import {
  bareShellAllows,
  type InstallCheck,
  installWarnings,
  isFolderTrusted,
  refusals,
  type SettingsView,
  urlMatches,
} from "./refusals.ts";
import type { SettingsFile, SettingsRead } from "./settings.ts";

type Json = Record<string, unknown>;
const ok = (value: Json): SettingsRead => ({ kind: "ok", value });
const MISSING: SettingsRead = { kind: "missing" };
const file = (scope: SettingsFile["scope"]): SettingsFile => ({ scope, path: `/${scope}.json` });

function view(over: Partial<Record<SettingsFile["scope"], Json>> = {}, global: Json = {}) {
  const scopes: SettingsFile["scope"][] = ["user", "project", "local", "managed"];
  return {
    files: scopes.map((scope) => ({
      file: file(scope),
      read: over[scope] === undefined ? MISSING : ok(over[scope] ?? {}),
    })),
    globalConfig: ok(global),
  } satisfies SettingsView;
}

const URL_ = "http://127.0.0.1:8787";
const check = (o: Partial<InstallCheck> = {}): InstallCheck => ({
  scope: "user",
  transport: "command",
  httpUrl: null,
  projectDir: "/work/repo",
  ...o,
});
const noGit = () => false;

describe("refusals (PLAN-M1 §4.3; spec: refuse when Bash is on the allow list)", () => {
  test("a clean setup has none", () => {
    expect(
      refusals(view({ user: { permissions: { allow: ["Read", "Bash(npm test *)"] } } }), check()),
    ).toEqual([]);
  });

  test.each(["Bash", "Bash(*)", "Bash(:*)", " Bash ", "PowerShell", "PowerShell(*)", "Monitor"])(
    "a bare %p allow rule at any scope",
    (rule) => {
      for (const scope of ["user", "project", "local", "managed"] as const) {
        const found = refusals(view({ [scope]: { permissions: { allow: [rule] } } }), check());
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(`/${scope}.json`);
        expect(found[0]).toContain("--force");
      }
    },
  );

  test("bareShellAllows lists every file and rule, ignoring narrow rules and junk", () => {
    const v = view({
      user: { permissions: { allow: ["Bash", 3, "Bash(git *)"] } },
      local: { permissions: { allow: ["PowerShell(*)"] } },
      project: { permissions: "junk" },
    });
    expect(bareShellAllows(v)).toEqual([
      { path: "/user.json", rule: "Bash" },
      { path: "/local.json", rule: "PowerShell(*)" },
    ]);
  });

  test("disableAllHooks in a non-managed file refuses a non-managed install only", () => {
    const v = view({ project: { disableAllHooks: true } });
    expect(refusals(v, check())[0]).toContain("disableAllHooks");
    expect(refusals(v, check({ scope: "managed" }))).toEqual([]);
  });

  test("disableAllHooks in managed settings refuses every scope", () => {
    const v = view({ managed: { disableAllHooks: true } });
    expect(refusals(v, check({ scope: "managed" }))[0]).toContain("managed");
    expect(refusals(v, check({ scope: "local" }))).toHaveLength(1);
  });

  test("allowManagedHooksOnly refuses a non-managed install", () => {
    const v = view({ managed: { allowManagedHooksOnly: true } });
    expect(refusals(v, check({ scope: "project" }))[0]).toContain("allowManagedHooksOnly");
    expect(refusals(v, check({ scope: "managed" }))).toEqual([]);
    expect(refusals(view({ user: { allowManagedHooksOnly: true } }), check())).toEqual([]);
  });

  test("--transport http needs the daemon's HTTP bind", () => {
    expect(refusals(view(), check({ transport: "http" }))[0]).toContain("[daemon] http");
    expect(refusals(view(), check({ transport: "http", httpUrl: URL_ }))).toEqual([]);
  });

  test("--transport http needs a matching allowedHttpHookUrls entry when the key exists", () => {
    const http = check({ transport: "http", httpUrl: URL_ });
    const allow = (list: unknown) => view({ user: { allowedHttpHookUrls: list } });
    expect(refusals(allow(["http://127.0.0.1:*"]), http)).toEqual([]);
    expect(refusals(allow(["https://hooks.example.com/*"]), http)[0]).toContain(
      "allowedHttpHookUrls",
    );
    expect(refusals(allow([]), http)).toHaveLength(1);
    expect(refusals(allow("junk"), http)).toHaveLength(1);
    const merged = view({
      user: { allowedHttpHookUrls: ["https://x/*"] },
      managed: { allowedHttpHookUrls: [`${URL_}/v1/hooks/claude-code`] },
    });
    expect(refusals(merged, http)).toEqual([]);
  });
});

describe("urlMatches: `*` is a wildcard, the rest literal", () => {
  test.each([
    ["http://localhost:*", "http://localhost:8787/v1/hooks/claude-code", true],
    ["http://127.0.0.1:8787/*", "http://127.0.0.1:8787/v1/hooks/claude-code", true],
    [
      "http://127.0.0.1:8787/v1/hooks/claude-code",
      "http://127.0.0.1:8787/v1/hooks/claude-code",
      true,
    ],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787/v1/hooks/claude-code", false],
    ["http://127.0.0.1.evil/*", "http://127.0.0.1:8787/v1/hooks/claude-code", false],
    ["http://127?0?0?1:*", "http://127.0.0.1:8787/x", false],
  ])("%p vs %p", (pattern, url, expected) => {
    expect(urlMatches(pattern, url)).toBe(expected);
  });
});

describe("installWarnings (never refuse)", () => {
  test("always: --dangerously-skip-permissions is out of scope and no OpenShell", () => {
    const w = installWarnings(
      view({}, { projects: { "/work/repo": { hasTrustDialogAccepted: true } } }),
      check(),
      noGit,
    );
    expect(w.some((l) => l.includes("--dangerously-skip-permissions"))).toBe(true);
    expect(w.some((l) => l.includes("Without OpenShell, every deny is best-effort"))).toBe(true);
    expect(w).toHaveLength(2);
  });

  test.each(["bypassPermissions", "dontAsk"])(
    "permissions.defaultMode %p: holds become denies",
    (mode) => {
      const w = installWarnings(
        view({ user: { permissions: { defaultMode: mode } } }),
        check(),
        noGit,
      );
      expect(w.some((l) => l.includes(mode) && l.includes("holds become denies"))).toBe(true);
    },
  );

  test("an untrusted folder holds hooks back in interactive sessions", () => {
    const w = installWarnings(view(), check(), noGit);
    expect(w.some((l) => l.includes("workspace trust") && l.includes("/work/repo"))).toBe(true);
  });

  test("an unreadable settings file is reported, not guessed", () => {
    const v: SettingsView = {
      ...view(),
      files: [{ file: file("project"), read: { kind: "invalid", error: "Unexpected token" } }],
    };
    expect(installWarnings(v, check(), noGit).some((l) => l.includes("/project.json"))).toBe(true);
  });

  test("a managed install warns that another managed source may win", () => {
    const trusted = { projects: { "/work/repo": { hasTrustDialogAccepted: true } } };
    const w = installWarnings(view({}, trusted), check({ scope: "managed" }), noGit);
    expect(w.some((l) => l.includes("first-wins"))).toBe(true);
  });
});

describe("isFolderTrusted (permissions#project-allow-rules-and-workspace-trust)", () => {
  const trust = (paths: string[]): SettingsRead =>
    ok({ projects: Object.fromEntries(paths.map((p) => [p, { hasTrustDialogAccepted: true }])) });

  test("outside a repository: the folder or a trusted parent", () => {
    expect(isFolderTrusted(trust(["/work/repo"]), "/work/repo", noGit)).toBe(true);
    expect(isFolderTrusted(trust(["/work"]), "/work/repo/sub", noGit)).toBe(true);
    expect(isFolderTrusted(trust(["/elsewhere"]), "/work/repo", noGit)).toBe(false);
  });

  test("in a repository: the repository root only (a parent's trust does not extend into it)", () => {
    const git = (p: string) => p === "/work/repo/.git";
    expect(isFolderTrusted(trust(["/work/repo"]), "/work/repo/src", git)).toBe(true);
    expect(isFolderTrusted(trust(["/work"]), "/work/repo/src", git)).toBe(false);
  });

  test("a missing, unreadable or odd ~/.claude.json is untrusted", () => {
    expect(isFolderTrusted({ kind: "missing" }, "/work", noGit)).toBe(false);
    expect(isFolderTrusted({ kind: "invalid", error: "x" }, "/work", noGit)).toBe(false);
    expect(isFolderTrusted(ok({ projects: "x" }), "/work", noGit)).toBe(false);
    expect(
      isFolderTrusted(
        ok({ projects: { "/work": { hasTrustDialogAccepted: "yes" } } }),
        "/work",
        noGit,
      ),
    ).toBe(false);
  });
});
