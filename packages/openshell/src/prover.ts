/**
 * The OpenShell policy prover as an optional, gateway-free check (PLAN-M2 §2 row 14):
 * `openshell-prover check <candidate> --boundary <boundary> --output json`
 * (crates/openshell-prover-cli/src/main.rs:37-52; docs/how-it-works/policies/prover.mdx:
 * 81-83, 151-156). Only `within_boundary` (exit 0) passes (prover.mdx:134-142). The prover
 * compares filesystem access path by path (prover.mdx:174-185), so a boundary is built per
 * candidate by {@link proverBoundary}: the same paths, no endpoint that reaches a judge host
 * (T13), `hard_requirement` Landlock (T1). Never downloaded: used when on PATH.
 */

import { judgeHostReached } from "./fragments/judge-hosts.ts";
import type { OpenShellPolicy } from "./schema.ts";

/** The prover binary's name. */
export const PROVER = "openshell-prover";

/** What one check answered. */
export interface ProverResult {
  /** `within_boundary`, `exceeds_boundary`, `error`, `unsupported`, `inconclusive`, or `unreadable`. */
  readonly result: string;
  readonly exitCode: number;
  readonly reason: string | null;
  readonly raw: string;
}

/** `PATH` without relative entries. */
function absolutePath(pathEnv: string): string {
  return pathEnv
    .split(":")
    .filter((dir) => dir.startsWith("/"))
    .join(":");
}

/** The prover's absolute path on the absolute entries of `pathEnv`, or null. */
export function findProver(pathEnv: string = process.env.PATH ?? ""): string | null {
  return Bun.which(PROVER, { PATH: absolutePath(pathEnv) });
}

/**
 * The boundary a compiled policy must stay within: its own filesystem paths and process
 * identity, Landlock `hard_requirement`, and its network rules minus every endpoint that
 * reaches one of `judgeHosts`. A candidate with a judge route or a weaker Landlock setting
 * exceeds it.
 */
export function proverBoundary(
  policy: OpenShellPolicy,
  judgeHosts: readonly string[],
): OpenShellPolicy {
  const rules = Object.entries(policy.network_policies ?? {}).flatMap(([key, rule]) => {
    const endpoints = (rule.endpoints ?? []).filter(
      (e) => e.host === undefined || judgeHostReached(e.host, judgeHosts) === null,
    );
    return endpoints.length === 0 ? [] : [[key, { ...rule, endpoints }] as const];
  });
  return {
    ...policy,
    landlock: { compatibility: "hard_requirement" },
    network_policies: Object.fromEntries(rules),
  };
}

interface Envelope {
  readonly result?: unknown;
  readonly exit_code?: unknown;
  readonly reason?: unknown;
}

/** Runs one boundary check with a minimal environment and a deadline. */
export async function proverCheck(
  prover: string,
  candidate: string,
  boundary: string,
  timeoutMs = 30_000,
): Promise<ProverResult> {
  const args = ["check", candidate, "--boundary", boundary, "--output", "json"];
  const proc = Bun.spawn([prover, ...args], {
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [raw, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  let envelope: Envelope = {};
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    envelope = {};
  }
  const result = typeof envelope.result === "string" ? envelope.result : "unreadable";
  const reason = typeof envelope.reason === "string" ? envelope.reason : null;
  return { result, exitCode, reason, raw };
}
