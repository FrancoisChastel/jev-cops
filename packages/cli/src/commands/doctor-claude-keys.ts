/**
 * `cops doctor`, the Claude Code settings keys that switch hooks off or change what a hook
 * decision means (PLAN-M1 §2 rows 7, 10, 16, 18; §4.4): `disableAllHooks`,
 * `allowManagedHooksOnly`, a bare `Bash`/`PowerShell` allow rule (T4), `defaultMode`, and
 * `allowedHttpHookUrls` for HTTP post handlers. Read-only.
 */
import type { HookFacts } from "./doctor-hook-checks.ts";
import { isRecord, type SettingsReadOf } from "./doctor-settings.ts";
import { type Check, check } from "./doctor-types.ts";

const GROUP = "claude-code settings";
const BARE_ALLOW = /^(Bash|PowerShell)(\(\s*\*\s*\))?$/;
const HOLD_BECOMES_DENY = "holds become denies (no one is asked, D-078)";

type Ok = SettingsReadOf & {
  readonly read: { readonly kind: "ok"; readonly value: Readonly<Record<string, unknown>> };
};

function parsed(reads: readonly SettingsReadOf[]): Ok[] {
  return reads.filter((r): r is Ok => r.read.kind === "ok");
}

function isManaged(r: SettingsReadOf): boolean {
  return r.file.scope === "managed";
}

function setting(r: Ok, key: string): unknown {
  return r.read.value[key];
}

function permissions(r: Ok): Record<string, unknown> {
  const p = setting(r, "permissions");
  return isRecord(p) ? p : {};
}

/** Whether a managed settings file registers jev-cops (exec form). */
function managedInstall(f: HookFacts): boolean {
  return f.cops.some((c) => c.form === "exec" && c.ref.file.scope === "managed");
}

function filesCheck(reads: readonly SettingsReadOf[]): Check {
  const invalid = reads.filter((r) => r.read.kind === "invalid");
  if (invalid.length > 0) {
    const list = invalid
      .map((r) => `${r.file.path} (${r.read.kind === "invalid" ? r.read.error : ""})`)
      .join("; ");
    return check(
      GROUP,
      "settings files",
      "warn",
      `not valid JSON: ${list}; Claude Code cannot use them`,
    );
  }
  const present = parsed(reads).map((r) => r.file.path);
  const detail = present.length === 0 ? "none present" : `read: ${present.join(", ")}`;
  return check(GROUP, "settings files", "ok", detail);
}

function disableAllHooksCheck(f: HookFacts): Check {
  const sets = parsed(f.view.reads).filter((r) => setting(r, "disableAllHooks") === true);
  const inManaged = sets.filter(isManaged).map((r) => r.file.path);
  if (inManaged.length > 0) {
    return check(
      GROUP,
      "disableAllHooks",
      "fail",
      `set in managed settings (${inManaged.join(", ")}): no hook runs, jev-cops included`,
    );
  }
  if (sets.length === 0) return check(GROUP, "disableAllHooks", "ok", "not set");
  const list = sets.map((r) => r.file.path).join(", ");
  if (managedInstall(f)) {
    return check(
      GROUP,
      "disableAllHooks",
      "warn",
      `set in ${list}: user, project and local hooks are off; the managed jev-cops install still runs`,
    );
  }
  return check(
    GROUP,
    "disableAllHooks",
    "fail",
    `set in ${list}: Claude Code runs no hook, jev-cops included, so every tool runs unjudged`,
  );
}

function allowManagedHooksOnlyCheck(f: HookFacts): Check {
  const sets = parsed(f.view.reads).filter(
    (r) => isManaged(r) && setting(r, "allowManagedHooksOnly") === true,
  );
  if (sets.length === 0) return check(GROUP, "allowManagedHooksOnly", "ok", "not set");
  const list = sets.map((r) => r.file.path).join(", ");
  if (managedInstall(f)) {
    return check(
      GROUP,
      "allowManagedHooksOnly",
      "ok",
      `set in ${list}; jev-cops is installed in managed settings`,
    );
  }
  return check(
    GROUP,
    "allowManagedHooksOnly",
    "fail",
    `set in ${list}: user, project and local hooks are blocked, jev-cops included; install with \`cops install claude-code --managed\``,
  );
}

function allowRulesCheck(reads: readonly SettingsReadOf[]): Check {
  const bare = parsed(reads).flatMap((r) => {
    const allow = permissions(r).allow;
    const rules = Array.isArray(allow)
      ? allow.filter((a): a is string => typeof a === "string")
      : [];
    return rules.filter((a) => BARE_ALLOW.test(a.trim())).map((a) => `"${a}" in ${r.file.path}`);
  });
  if (bare.length === 0)
    return check(GROUP, "permissions.allow", "ok", "no bare Bash or PowerShell allow rule");
  return check(
    GROUP,
    "permissions.allow",
    "warn",
    `${bare.join("; ")}: the T4 gap is present and unmitigated. An exit-2 deny still wins, but a hook ask against a bare allow rule is undocumented; scope the rule (e.g. "Bash(git status *)")`,
  );
}

/** Managed (later drop-ins first), then local, project, user: the first `defaultMode` wins. */
function byPrecedence(reads: readonly Ok[]): Ok[] {
  const rank = { managed: 0, local: 1, project: 2, user: 3 } as const;
  const managed = reads.filter(isManaged).reverse();
  const others = reads
    .filter((r) => !isManaged(r))
    .sort((a, b) => rank[a.file.scope] - rank[b.file.scope]);
  return [...managed, ...others];
}

function defaultModeCheck(reads: readonly SettingsReadOf[]): Check {
  const first = byPrecedence(parsed(reads)).find(
    (r) => typeof permissions(r).defaultMode === "string",
  );
  if (first === undefined) {
    return check(
      GROUP,
      "defaultMode",
      "ok",
      "not set (interactive sessions start in auto mode, -p in default)",
    );
  }
  const mode = String(permissions(first).defaultMode);
  const at = `${mode} (${first.file.path})`;
  if (mode === "dontAsk") return check(GROUP, "defaultMode", "warn", `${at}: ${HOLD_BECOMES_DENY}`);
  if (mode === "bypassPermissions") {
    return check(
      GROUP,
      "defaultMode",
      "warn",
      `${at}: ${HOLD_BECOMES_DENY}, and Claude Code's own prompts for writes to .claude/ are skipped: config-tamper is the only guard`,
    );
  }
  return check(GROUP, "defaultMode", "ok", at);
}

/** Whether `url` matches an `allowedHttpHookUrls` pattern (`*` matches anything). */
export function matchesUrl(url: string, pattern: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(`^${source.join(".*")}$`).test(url);
}

function httpAllowlistCheck(f: HookFacts): Check {
  const lists = parsed(f.view.reads)
    .map((r) => setting(r, "allowedHttpHookUrls"))
    .filter(Array.isArray);
  const patterns = lists.flat().filter((p): p is string => typeof p === "string");
  const urls = f.cops.filter((c) => c.form === "http").map((c) => String(c.ref.handler.url));
  if (lists.length === 0) {
    const note = urls.length === 0 ? "" : "; jev-cops's HTTP post handlers are not filtered";
    return check(GROUP, "allowedHttpHookUrls", "ok", `not set${note}`);
  }
  if (urls.length === 0)
    return check(GROUP, "allowedHttpHookUrls", "ok", "set; jev-cops uses command hooks only");
  const blocked = urls.filter((u) => !patterns.some((p) => matchesUrl(u, p)));
  if (blocked.length === 0)
    return check(GROUP, "allowedHttpHookUrls", "ok", "every jev-cops HTTP post handler is allowed");
  return check(
    GROUP,
    "allowedHttpHookUrls",
    "warn",
    `${blocked.join(", ")} not in allowedHttpHookUrls: Claude Code drops those post events, so tool-output taint (T10) is not recorded`,
  );
}

/** Every settings-key check, in report order. */
export function keyChecks(f: HookFacts): Check[] {
  return [
    filesCheck(f.view.reads),
    disableAllHooksCheck(f),
    allowManagedHooksOnlyCheck(f),
    allowRulesCheck(f.view.reads),
    defaultModeCheck(f.view.reads),
    httpAllowlistCheck(f),
  ];
}
