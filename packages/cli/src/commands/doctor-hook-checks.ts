/**
 * `cops doctor`, the Claude Code hook as registered (PLAN-M1 §4.4, §5 rows 1, 8 and 22):
 * in force on every required event (the adapter's D-087 "intact" check, reused as is), in
 * exec form, its binary present and executable, `--version` matching the CLI, talking to
 * copsd's socket, no mismatched duplicates, and no other PreToolUse hook that could
 * rewrite the input. Read-only; the only process started is the hook with `--version`.
 */
import { checkIntact, REQUIRED_EVENTS } from "@jev-cops/adapter-claude-code";
import { CLI_VERSION } from "../version.ts";
import {
  type CopsForm,
  type CopsIdentity,
  copsForm,
  type HandlerRef,
  handlersOf,
  hookIdentityOf,
  identityOf,
  type SettingsView,
  unrunnable,
} from "./doctor-settings.ts";
import { type Check, type CheckStatus, check, type DoctorEnv } from "./doctor-types.ts";

const GROUP = "claude-code hook";
const VERSION_TIMEOUT_MS = 5_000;
const VERSION = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/;

/** A jev-cops handler and how it is registered. */
export interface CopsEntry {
  readonly ref: HandlerRef;
  readonly form: CopsForm;
}

/** What the settings register: every handler, jev-cops's, and its distinct exec-form hooks. */
export interface HookFacts {
  readonly view: SettingsView;
  readonly handlers: readonly HandlerRef[];
  readonly cops: readonly CopsEntry[];
  readonly identities: readonly CopsIdentity[];
}

/** Collects the handlers of `view` and the distinct jev-cops hooks among them. */
export function hookFacts(view: SettingsView, e: DoctorEnv): HookFacts {
  const handlers = handlersOf(view.reads);
  const cops = handlers.flatMap((ref) => {
    const form = copsForm(ref.handler);
    return form === null ? [] : [{ ref, form }];
  });
  const seen = new Map<string, CopsIdentity>();
  for (const c of cops) {
    if (c.form !== "exec") continue;
    const id = identityOf(c.ref.handler, view.projectDir, e);
    if (!seen.has(id.key)) seen.set(id.key, id);
  }
  return { view, handlers, cops, identities: [...seen.values()] };
}

function where(ref: HandlerRef): string {
  return `${ref.file.path} (${ref.event})`;
}

/** Whether the hook is in force on every required event, by the ConfigChange rule (D-087). */
export function registrationCheck(f: HookFacts, e: DoctorEnv): Check {
  const files = f.view.reads.map((r) => r.file.path).join(", ");
  if (f.cops.length === 0) {
    return check(
      GROUP,
      "registered",
      "fail",
      `no jev-cops hook in the settings Claude Code loads (${files}): every tool runs unjudged. Run \`cops install claude-code\`.`,
    );
  }
  const results = f.identities.map((id) =>
    checkIntact(f.view.reads, hookIdentityOf(id, f.view, e)),
  );
  if (results.some((r) => r.intact)) {
    return check(
      GROUP,
      "registered",
      "ok",
      `in force on ${REQUIRED_EVENTS.join(", ")} (exec form, every tool, D-087)`,
    );
  }
  const why = results[0]?.why ?? "no exec-form jev-cops command hook";
  return check(
    GROUP,
    "registered",
    "fail",
    `${why}. Claude Code does not send those events to jev-cops, and the ConfigChange guard counts the setup as not intact (D-087): re-run \`cops install claude-code\`.`,
  );
}

/** Every jev-cops command entry must be exec form (`args`), which is what "intact" requires. */
export function execFormCheck(f: HookFacts): Check {
  const shell = f.cops.filter((c) => c.form === "shell");
  if (shell.length === 0)
    return check(GROUP, "exec form", "ok", "every jev-cops command entry passes `args` (no shell)");
  const list = shell.map((c) => where(c.ref)).join("; ");
  return check(
    GROUP,
    "exec form",
    "fail",
    `shell-form entry in ${list}: a shell can print before the JSON and does not count as intact (D-087); reinstall in exec form`,
  );
}

/** The binary of each registered hook exists and is executable (§5 row 1: "gate silently disabled"). */
export function binaryChecks(f: HookFacts): Check[] {
  return f.identities.map((id) => {
    if (id.commandFile === null) {
      return check(
        GROUP,
        "hook binary",
        "fail",
        `"${id.command}" is not on PATH: Claude Code cannot start the hook, a non-blocking error, so every tool runs unjudged (gate silently disabled)`,
      );
    }
    const why = unrunnable(id.commandFile);
    if (why === null)
      return check(GROUP, "hook binary", "ok", `${id.commandFile} is an executable file`);
    return check(
      GROUP,
      "hook binary",
      "fail",
      `${id.commandFile} ${why}: Claude Code cannot start the hook, a non-blocking error, so every tool runs unjudged (gate silently disabled)`,
    );
  });
}

/** Each registered hook talks to copsd's agent socket. */
export function socketChecks(f: HookFacts, daemonSocket: string): Check[] {
  return f.identities.map((id) => {
    if (id.socket === null) {
      return check(
        GROUP,
        "socket",
        "fail",
        `the arguments of ${id.command} do not parse (${id.args.join(" ")}): the hook blocks every call (fail closed)`,
      );
    }
    if (id.socket === daemonSocket)
      return check(GROUP, "socket", "ok", `--socket ${id.socket} is copsd's agent socket`);
    return check(
      GROUP,
      "socket",
      "fail",
      `the hook talks to ${id.socket}, copsd listens on ${daemonSocket}: every call is blocked (fail closed) or judged by another daemon`,
    );
  });
}

/** One jev-cops hook, not several that differ (§2 row 22: different sockets double-judge). */
export function duplicatesCheck(f: HookFacts): Check {
  if (f.identities.length <= 1) {
    return check(
      GROUP,
      "duplicates",
      "ok",
      "no mismatched jev-cops entries (Claude Code runs identical handlers once)",
    );
  }
  const list = f.identities
    .map((id) => `${id.commandFile ?? id.command} → ${id.socket ?? "?"}`)
    .join("; ");
  return check(
    GROUP,
    "duplicates",
    "warn",
    `${f.identities.length} different jev-cops hooks run on every call: ${list}. Keep one install.`,
  );
}

function describeHandler(ref: HandlerRef): string {
  const h = ref.handler;
  const target =
    typeof h.command === "string" ? h.command : typeof h.url === "string" ? h.url : "?";
  return `${String(h.type)} ${target} in ${ref.file.path}`;
}

/** No other PreToolUse hook that could return `updatedInput` (§5 row 8). */
export function foreignHooksCheck(f: HookFacts): Check {
  const foreign = f.handlers.filter(
    (ref) => ref.event === "PreToolUse" && copsForm(ref.handler) === null,
  );
  if (foreign.length === 0) return check(GROUP, "other PreToolUse hooks", "ok", "none");
  const list = foreign.map(describeHandler).join("; ");
  return check(
    GROUP,
    "other PreToolUse hooks",
    "warn",
    `${list}: it can return \`updatedInput\`, and the last hook to finish wins over jev-cops's rewrite; its allow cannot undo jev-cops's deny`,
  );
}

async function versionCheck(id: CopsIdentity, e: DoctorEnv): Promise<Check> {
  const argv = [id.commandFile ?? id.command, ...id.leading, "--version"];
  const res = await e.run({
    argv,
    env: { ...e.env, HOME: e.home },
    cwd: e.cwd,
    stdin: "",
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const version = res.exitCode === 0 ? (VERSION.exec(res.stdout.trim())?.[0] ?? null) : null;
  if (version === null) {
    const why =
      res.error ??
      `exit ${res.exitCode ?? "timeout"}${res.stderr.trim() === "" ? "" : `: ${res.stderr.trim().split("\n")[0]}`}`;
    return check(
      GROUP,
      "hook version",
      "warn",
      `the hook does not report a version (${argv.join(" ")} → ${why}); cannot confirm it matches cops ${CLI_VERSION}`,
    );
  }
  const status: CheckStatus = version === CLI_VERSION ? "ok" : "warn";
  const detail =
    status === "ok"
      ? `${version} = cops ${CLI_VERSION}`
      : `${version}, cops ${CLI_VERSION}: reinstall the hook from this release`;
  return check(GROUP, "hook version", status, detail);
}

/** `<hook> --version` for each runnable registered hook, against the CLI's version. */
export async function hookVersionChecks(f: HookFacts, e: DoctorEnv): Promise<Check[]> {
  const runnable = f.identities.filter(
    (id) => id.commandFile !== null && unrunnable(id.commandFile) === null,
  );
  return Promise.all(runnable.map((id) => versionCheck(id, e)));
}
