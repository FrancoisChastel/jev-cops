/**
 * `openshell` argument vectors, exactly as the v0.1.2 clap definitions spell them
 * (crates/openshell-cli/src/main.rs at `main` 7caff12, cited as `main.rs:<line>`). Pure:
 * cli.ts runs them, the report prints them.
 */
import type { PolicyUpdate } from "./types.ts";

/** `--timeout` for every `--wait` (PLAN-M2 §2 row 5: the wrapper always waits, 20 s). */
export const WAIT_TIMEOUT_S = 20;

/**
 * `policy update <sandbox> --rule-name <r> --binary <b>… --add-endpoint <e> --wait
 * --timeout <s>` (main.rs:2106-2166: `--rule-name`, repeatable `--binary`, `--add-endpoint`,
 * `--wait`, `--timeout`).
 */
export function policyUpdateArgs(
  sandbox: string,
  update: PolicyUpdate,
  timeoutS: number = WAIT_TIMEOUT_S,
): string[] {
  return [
    "policy",
    "update",
    sandbox,
    "--rule-name",
    update.ruleName,
    ...update.binaries.flatMap((b) => ["--binary", b]),
    "--add-endpoint",
    update.addEndpoint,
    "--wait",
    "--timeout",
    String(timeoutS),
  ];
}

/** `policy update <sandbox> --remove-rule <r> --wait --timeout <s>` (main.rs:2133-2135). */
export function removeRuleArgs(
  sandbox: string,
  rule: string,
  timeoutS: number = WAIT_TIMEOUT_S,
): string[] {
  return [
    "policy",
    "update",
    sandbox,
    "--remove-rule",
    rule,
    "--wait",
    "--timeout",
    String(timeoutS),
  ];
}

/** `policy set <sandbox> --policy <file> --wait --timeout <s>` (main.rs:2078-2102; no `--dry-run`). */
export function policySetArgs(
  sandbox: string,
  file: string,
  timeoutS: number = WAIT_TIMEOUT_S,
): string[] {
  return ["policy", "set", sandbox, "--policy", file, "--wait", "--timeout", String(timeoutS)];
}

/** `policy get <sandbox> --base --output json` (main.rs:2169-2194). */
export function policyGetBaseArgs(sandbox: string): string[] {
  return ["policy", "get", sandbox, "--base", "--output", "json"];
}

/** `policy list <sandbox> --output json` (main.rs:2197-2218). */
export function policyListArgs(sandbox: string): string[] {
  return ["policy", "list", sandbox, "--output", "json"];
}

/** What `sandbox create` needs from jev-cops (main.rs:1423-1590). */
export interface CreateOptions {
  readonly name: string;
  /** Image reference or rootfs tar (`--from`); omitted: the gateway's default image. */
  readonly from: string | null;
  /** The compiled policy file (`--policy`). */
  readonly policyFile: string;
  /** Provider names (`--provider`, repeatable): the model endpoint and its credential. */
  readonly providers: readonly string[];
  /** Non-secret `KEY=VALUE` pairs (`--env`, repeatable). */
  readonly env: readonly string[];
  /** The canonical main process after `--`; empty: a detached login shell. */
  readonly command: readonly string[];
}

/**
 * `sandbox create --name <n> [--from <img>] --policy <file> --no-auto-providers
 * --approval-mode manual [--provider p]… [--env K=V]… --detach --output json [-- cmd…]`.
 * `--policy` (main.rs:1504-1506), `--no-auto-providers` never creates providers from local
 * credentials (:1552-1555), `--approval-mode manual` (:1570-1581; D-119, advisor.mdx:176-184),
 * `--env` (:1563-1565), `--provider` (:1498-1501), `--detach` "Start the canonical main
 * process without attaching to it" (:1535-1536), `--output json` for the result
 * (sandboxes/overview.mdx:79-83).
 */
export function sandboxCreateArgs(o: CreateOptions): string[] {
  return [
    "sandbox",
    "create",
    "--name",
    o.name,
    ...(o.from === null ? [] : ["--from", o.from]),
    "--policy",
    o.policyFile,
    "--no-auto-providers",
    "--approval-mode",
    "manual",
    ...o.providers.flatMap((p) => ["--provider", p]),
    ...o.env.flatMap((e) => ["--env", e]),
    "--detach",
    "--output",
    "json",
    ...(o.command.length === 0 ? [] : ["--", ...o.command]),
  ];
}

/** `settings set <sandbox> --key <k> --value <v>` (main.rs:2252-2273). */
export function settingsSetArgs(sandbox: string, key: string, value: string): string[] {
  return ["settings", "set", sandbox, "--key", key, "--value", value];
}

/**
 * The advisor settings `cops openshell create` pins on the sandbox (D-119): no agent
 * proposals, manual approval (advisor.mdx:78-100, :168-184).
 */
export const ADVISOR_SETTINGS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["agent_policy_proposals_enabled", "false"],
  ["proposal_approval_mode", "manual"],
]);

/** Renders argv as one shell-readable line (single-quoting anything unusual). */
export function commandLine(binary: string, args: readonly string[]): string {
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);
  return [binary, ...args].map(quote).join(" ");
}
