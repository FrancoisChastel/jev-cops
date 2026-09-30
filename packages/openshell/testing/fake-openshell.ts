/**
 * A fake `openshell` binary for tests (PLAN-M2 §4, step 2): an executable script that
 * appends each call's argv and environment to `calls.jsonl`, then answers from canned
 * responses (first argv-prefix match wins; default exit 0, no output), with exit codes 0, 1
 * or 124 like `--wait` (manage-policies.mdx:254-258) and an optional delay. Like the real
 * CLI (manage-policies.mdx:358), it rejects a `--policy` file the schema mirror rejects.
 * Used by the openshell package, the CLI and (step 3) the daemon tests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeBunScript } from "./script.ts";

/** One canned answer. */
export interface FakeResponse {
  /** Answers a call whose argv starts with these words. */
  readonly match: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
  readonly sleepMs?: number;
}

/** One recorded call. */
export interface FakeCall {
  readonly argv: string[];
  readonly env: Record<string, string>;
}

/** A fake binary in `dir`. */
export interface FakeOpenShell {
  /** Absolute path of the executable. */
  readonly binary: string;
  /** Every call so far, in order. */
  calls(): FakeCall[];
  /** Replaces the canned responses. */
  respond(responses: readonly FakeResponse[]): void;
}

const SCHEMA = join(import.meta.dir, "..", "src", "schema.ts");

function script(config: string, calls: string): string {
  return `const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, env: process.env }) + "\\n");
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, "utf8"));
const hit = responses.find((r) => r.match.every((w, i) => argv[i] === w)) ?? {};
const at = argv.indexOf("--policy");
const takesPolicy = (argv[0] === "sandbox" && argv[1] === "create") || (argv[0] === "policy" && argv[1] === "set");
if (at !== -1 && takesPolicy) {
  const { parsePolicyYaml } = await import(${JSON.stringify(SCHEMA)});
  let parsed;
  try { parsed = parsePolicyYaml(fs.readFileSync(argv[at + 1], "utf8")); }
  catch (e) { parsed = { ok: false, error: [String(e)] }; }
  if (!parsed.ok) { console.error("Error: invalid sandbox policy: " + parsed.error.join("; ")); process.exit(1); }
}
if (hit.sleepMs) await Bun.sleep(hit.sleepMs);
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.exit ?? 0);
`;
}

/** Writes a fake `openshell` into `dir` (created if missing) answering `responses`. */
export function createFakeOpenShell(
  dir: string,
  responses: readonly FakeResponse[] = [],
): FakeOpenShell {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "fake-openshell.json");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(config, JSON.stringify(responses));
  writeFileSync(calls, "");
  const binary = writeBunScript(dir, "openshell", script(config, calls));
  return {
    binary,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as FakeCall)
        : [],
    respond: (next) => writeFileSync(config, JSON.stringify(next)),
  };
}

/** Canned `--output json` bodies shaped like the v0.1.2 CLI's (run.rs, output.rs). */
export const CANNED = Object.freeze({
  /** `policy list -o json`: `{ revisions, next_page_token }` (output.rs:44-63, run.rs:5747-5800). */
  policyList: (revisions: ReadonlyArray<{ version: number; status: string }>) =>
    JSON.stringify({
      revisions: revisions.map((r) => ({ scope: "sandbox", sandbox: "sb", hash: "h", ...r })),
      next_page_token: "",
    }),
  /** `policy get --base -o json`: revision metadata plus `policy` (run.rs:5747-5800). */
  policyGet: (policy: unknown, version = 3) =>
    JSON.stringify({
      scope: "sandbox",
      sandbox: "sb",
      version,
      hash: "h",
      status: "loaded",
      policy,
    }),
  /** `sandbox get -o json` (run.rs:2715-2800). */
  sandboxGet: (phase: string, name = "sb") =>
    JSON.stringify({ id: "sb-1", name, phase, current_policy_version: 3, conditions: [] }),
  /** `settings get --json` (run.rs:4925-4964). */
  settings: (settings: Readonly<Record<string, { value: string; scope: string }>>) =>
    JSON.stringify({ sandbox: "sb", workspace: "default", config_revision: 1, settings }),
});
