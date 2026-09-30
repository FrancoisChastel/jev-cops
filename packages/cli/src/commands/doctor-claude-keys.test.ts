import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  installHook,
  userSettingsPath,
  writeJson,
} from "../testing/doctor.ts";
import { keyChecks, matchesUrl } from "./doctor-claude-keys.ts";
import { hookFacts } from "./doctor-hook-checks.ts";
import { readClaudeSettings } from "./doctor-settings.ts";
import type { Check } from "./doctor-types.ts";

let f: DoctorFixture;
let socket = "";
beforeEach(() => {
  f = doctorFixture();
  socket = join(f.root, "copsd.sock");
});
afterEach(() => f.dispose());

function checks(): Check[] {
  const e = doctorEnv(f);
  return keyChecks(hookFacts(readClaudeSettings(e), e));
}
const named = (name: string) => checks().find((c) => c.name === name);
const managed = (name: string) => join(f.managed, name);

describe("doctor: Claude Code settings keys", () => {
  test("a clean install: every key check is ok", () => {
    installHook(f, socket);
    const all = checks();
    expect(all.map((c) => [c.name, c.status])).toEqual([
      ["settings files", "ok"],
      ["disableAllHooks", "ok"],
      ["allowManagedHooksOnly", "ok"],
      ["permissions.allow", "ok"],
      ["defaultMode", "ok"],
      ["allowedHttpHookUrls", "ok"],
    ]);
    expect(all.every((c) => c.group === "claude-code settings")).toBe(true);
    // Auto mode is the starting mode only from 2.1.283; 2.1.280 started in default (live run).
    expect(all.find((c) => c.name === "defaultMode")?.detail).toBe(
      "not set (interactive sessions start in auto mode from Claude Code 2.1.283, in default before; -p in default)",
    );
  });

  test("a settings file that is not JSON warns", () => {
    installHook(f, socket);
    writeJson(join(f.project, ".claude", "settings.json"), {});
    writeFileSync(join(f.project, ".claude", "settings.local.json"), "{ // comment\n}");
    const c = named("settings files");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("settings.local.json");
  });

  test("disableAllHooks: fail in user settings or managed settings; warn over a managed install", () => {
    installHook(f, socket, { disableAllHooks: true });
    expect(named("disableAllHooks")).toMatchObject({ status: "fail" });
    installHook(f, socket);
    writeJson(managed("managed-settings.json"), { disableAllHooks: true });
    expect(named("disableAllHooks")?.detail).toContain("no hook runs");
    writeJson(managed("managed-settings.json"), installHook(f, socket, { disableAllHooks: true }));
    const overManaged = named("disableAllHooks");
    expect(overManaged?.status).toBe("fail");
  });

  test("disableAllHooks outside managed settings leaves a managed install running: warn", () => {
    writeJson(managed("managed-settings.json"), installHook(f, socket));
    writeJson(userSettingsPath(f), { disableAllHooks: true });
    expect(named("disableAllHooks")?.status).toBe("warn");
  });

  test("allowManagedHooksOnly: fail over a user install, ok over a managed one", () => {
    installHook(f, socket);
    writeJson(managed("managed-settings.json"), { allowManagedHooksOnly: true });
    expect(named("allowManagedHooksOnly")?.status).toBe("fail");
    const settings = installHook(f, socket);
    writeJson(join(f.managed, "managed-settings.d", "50-jev-cops.json"), settings);
    expect(named("allowManagedHooksOnly")?.status).toBe("ok");
  });

  test("a bare Bash or PowerShell allow rule warns (T4: the gap is present and unmitigated)", () => {
    installHook(f, socket, { permissions: { allow: ["Bash(git status *)", "Read"] } });
    expect(named("permissions.allow")?.status).toBe("ok");
    installHook(f, socket, { permissions: { allow: ["Bash"] } });
    const bare = named("permissions.allow");
    expect(bare?.status).toBe("warn");
    expect(bare?.detail).toContain("T4");
    writeJson(join(f.project, ".claude", "settings.local.json"), {
      permissions: { allow: ["PowerShell(*)"] },
    });
    expect(named("permissions.allow")?.detail).toContain("PowerShell(*)");
  });

  test("defaultMode: dontAsk and bypassPermissions warn, managed wins over user", () => {
    installHook(f, socket, { permissions: { defaultMode: "acceptEdits" } });
    expect(named("defaultMode")).toMatchObject({ status: "ok" });
    installHook(f, socket, { permissions: { defaultMode: "bypassPermissions" } });
    expect(named("defaultMode")?.detail).toContain("config-tamper is the only guard");
    writeJson(managed("managed-settings.json"), { permissions: { defaultMode: "dontAsk" } });
    const c = named("defaultMode");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("dontAsk");
    expect(c?.detail).toContain("holds become denies");
  });

  test("allowedHttpHookUrls: an HTTP post handler outside the allowlist warns", () => {
    const url = "http://127.0.0.1:7777/v1/hooks/claude-code";
    const settings = installHook(f, socket, { allowedHttpHookUrls: ["http://localhost:*/*"] }) as {
      hooks: Record<string, unknown[]>;
    };
    expect(named("allowedHttpHookUrls")?.detail).toContain("command hooks");
    const post = [...(settings.hooks.PostToolUse ?? []), { hooks: [{ type: "http", url }] }];
    writeJson(userSettingsPath(f), {
      ...settings,
      hooks: { ...settings.hooks, PostToolUse: post },
    });
    const c = named("allowedHttpHookUrls");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain(url);
    writeJson(userSettingsPath(f), {
      ...settings,
      allowedHttpHookUrls: ["http://127.0.0.1:*/v1/hooks/*"],
      hooks: { ...settings.hooks, PostToolUse: post },
    });
    expect(named("allowedHttpHookUrls")?.status).toBe("ok");
  });

  test("URL patterns: * is a wildcard, everything else literal", () => {
    expect(matchesUrl("http://127.0.0.1:1/v1/hooks/claude-code", "http://127.0.0.1:*/v1/*")).toBe(
      true,
    );
    expect(matchesUrl("http://evil.test/v1", "http://127.0.0.1:*/v1/*")).toBe(false);
    expect(matchesUrl("http://a.b/x", "http://a?b/x")).toBe(false);
  });
});
