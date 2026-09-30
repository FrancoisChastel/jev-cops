/**
 * The OpenShell compiler (spec §Policy compilation, PLAN-M2 §4): one pure function from the
 * judge's inputs (harness layout, loaded policies, task, repo, judge route) to one OpenShell
 * policy YAML plus a report of what it allows, what it deliberately leaves out, what the
 * kernel cannot protect, and why it would refuse. It reads no file, runs nothing, never
 * throws; a non-empty `refusals` means no policy at all, never a weaker one.
 */
import manifest from "../package.json" with { type: "json" };
import { emitPolicy, inputsHash } from "./emit.ts";
import { type PolicyRef, policyFragmentsFor, policyLabel } from "./findings.ts";
import { JUDGE_PROVIDER_HOSTS, t13Refusals } from "./fragments/judge-hosts.ts";
import { JUDGE_RULE, judgeRouteFragment } from "./fragments/judge-route.ts";
import { protectionFragment } from "./fragments/protection.ts";
import { type RepoInput, TASK_RULES, taskAllowlistFragment } from "./fragments/task-allowlist.ts";
import type { Harness, SandboxLayout } from "./layout.ts";
import { type OpenShellPolicy, parsePolicy } from "./schema.ts";
import type { Absent, PolicyUpdate } from "./types.ts";

/** The compiler's version: the package's, in lockstep with `cops --version`. */
export const COMPILER_VERSION: string = manifest.version;
/** Every rule the compiler writes starts with this; `_provider_*` rules are never ours. */
export const RULE_PREFIX = "jev_cops_";

/** Everything the policy is compiled from (PLAN-M2 §4 `CompileInput`). */
export interface CompileInput {
  readonly harness: Harness;
  readonly layout: SandboxLayout;
  /** The daemon's loaded set; only `name`, `version` and `range` are read. */
  readonly policies: readonly PolicyRef[];
  /** More kill-tier sandbox paths (the daemon's protected paths, rewritten for the sandbox). */
  readonly protectedPaths?: readonly string[];
  /** More sandbox paths that must stay unreadable, beside `~/.jev-cops`. */
  readonly privatePaths?: readonly string[];
  /** The declared task (first user prompt), or null before it is known. */
  readonly task: string | null;
  readonly repo: RepoInput | null;
  /** copsd's sandbox listener; null: no judge route. */
  readonly judge: { readonly port: number } | null;
  /** Judge endpoints beyond `@jev-cops/judge`'s defaults (configured base URLs). */
  readonly judgeHosts?: readonly string[];
  /** Operator additions to `read_write`, checked like the rest. */
  readonly extraReadWrite?: readonly string[];
}

/** One fragment of the policy and the policies it stands for. */
export interface FragmentEntry {
  readonly name: "protection" | "judge-route" | "task-allowlist";
  readonly section: "filesystem" | "network";
  readonly backs: readonly string[];
}

/** The compiler's result (PLAN-M2 §4 `CompiledPolicy`). */
export interface CompiledPolicy {
  /** The full policy for `sandbox create --policy`; null when refused. */
  readonly policy: OpenShellPolicy | null;
  /** {@link policy} as deterministic YAML; null when refused. */
  readonly yaml: string | null;
  /** `policy update` calls for the live part (task hosts, at the first prompt; D-109). */
  readonly updates: readonly PolicyUpdate[];
  readonly fragments: readonly FragmentEntry[];
  readonly absent: readonly Absent[];
  readonly gaps: readonly string[];
  readonly refusals: readonly string[];
  /** The judge provider hosts no endpoint may reach (T13), sorted. */
  readonly judgeHosts: readonly string[];
  /** SHA-256 of the normalized input, also in the YAML header. */
  readonly inputsHash: string;
}

const JUDGE_ROUTE_BACKS = "judge route (D-105)";
const PROVIDER_RULES: Absent = {
  why: "model endpoints come from the attached provider profile (`_provider_*` rules, schema.mdx:116-117); the compiler never emits or removes them",
};
const SHARED_IDENTITY =
  "every process the agent starts shares the agent's network rules (network-rules.mdx:71-73): the task allowlist bounds where data can go, not which tool sends it";
const PROVIDER_T13 =
  "T13 is asserted on the base policy only: the gateway composes provider rules (`_provider_*`) into the effective policy, so a provider profile that allows a judge host (OpenRouter as both Pi's model provider and the judge) opens that route; check `policy get --full` (cops doctor, step 7)";
const PI_JUDGE_ROUTE =
  "Pi: the judge route is node's, so every tool Pi spawns can reach copsd's four routes; a resolve on the sandbox listener allows the one call only (PLAN-M2 §2 row 9, D-111)";

function normalized(input: CompileInput, version: string): Record<string, unknown> {
  const refs = input.policies.map(policyLabel).sort();
  return {
    compiler: version,
    harness: input.harness,
    layout: input.layout,
    policies: refs,
    protectedPaths: [...(input.protectedPaths ?? [])].sort(),
    privatePaths: [...(input.privatePaths ?? [])].sort(),
    task: input.task,
    repo:
      input.repo === null ? null : { ...input.repo, lockfiles: [...input.repo.lockfiles].sort() },
    judge: input.judge,
    judgeHosts: judgeHostsOf(input),
    extraReadWrite: [...(input.extraReadWrite ?? [])].sort(),
  };
}

function judgeHostsOf(input: CompileInput): string[] {
  const extra = (input.judgeHosts ?? []).map((h) => h.toLowerCase());
  return [...new Set([...JUDGE_PROVIDER_HOSTS, ...extra])].sort();
}

function backsOf(policies: readonly PolicyRef[], kind: "protection" | "task-allowlist"): string[] {
  return policies
    .filter((p) => policyFragmentsFor(p).kind === kind)
    .map(policyLabel)
    .sort();
}

function policyAbsent(policies: readonly PolicyRef[]): Absent[] {
  return [...policies]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((p) => {
      const m = policyFragmentsFor(p);
      return m.kind === "none" ? [{ why: `${policyLabel(p)}: ${m.why}` }] : [];
    });
}

function commentMap(
  policy: OpenShellPolicy,
  protection: readonly string[],
  task: readonly string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const taskRules: readonly string[] = Object.values(TASK_RULES);
  if (protection.length > 0) out.filesystem_policy = [...protection];
  for (const key of Object.keys(policy.network_policies ?? {})) {
    if (key === JUDGE_RULE) out[`network_policies.${key}`] = [JUDGE_ROUTE_BACKS];
    else if (taskRules.includes(key) && task.length > 0) {
      out[`network_policies.${key}`] = [...task];
    }
  }
  return out;
}

/** The three fragments of one input. */
function fragmentsOf(input: CompileInput, judgeHosts: readonly string[]) {
  const { harness, layout } = input;
  return {
    protection: protectionFragment({
      harness,
      layout,
      protectedPaths: input.protectedPaths ?? [],
      privatePaths: input.privatePaths ?? [],
      extraReadWrite: input.extraReadWrite ?? [],
    }),
    judge: judgeRouteFragment(harness, layout, input.judge),
    task: taskAllowlistFragment({
      task: input.task,
      repo: input.repo,
      binaries: layout.agentBinaries,
      judgeHosts,
    }),
  };
}

type Fragments = ReturnType<typeof fragmentsOf>;

function assemble({ protection, judge, task }: Fragments): OpenShellPolicy {
  return {
    version: 1,
    filesystem_policy: protection.filesystem,
    landlock: protection.landlock,
    ...(protection.process === undefined ? {} : { process: protection.process }),
    network_policies: { ...judge.rules, ...task.rules },
  };
}

function refusalsOf(f: Fragments, policy: OpenShellPolicy, judgeHosts: readonly string[]) {
  const parsed = parsePolicy(policy);
  return [
    ...f.protection.refusals,
    ...f.judge.refusals,
    ...f.task.refusals,
    ...(parsed.ok ? [] : parsed.error.map((p) => `schema: ${p}`)),
    ...t13Refusals(policy, judgeHosts),
  ];
}

/** The parts of the result that do not depend on a refusal. */
function reportOf(
  input: CompileInput,
  f: Fragments,
  backs: { protection: string[]; task: string[] },
) {
  return {
    fragments: [
      { name: "protection", section: "filesystem", backs: backs.protection },
      { name: "judge-route", section: "network", backs: [JUDGE_ROUTE_BACKS] },
      { name: "task-allowlist", section: "network", backs: backs.task },
    ] as const,
    absent: [
      ...f.protection.absent,
      ...f.judge.absent,
      ...f.task.absent,
      ...policyAbsent(input.policies),
      PROVIDER_RULES,
    ],
    gaps: [
      ...f.protection.gaps,
      SHARED_IDENTITY,
      PROVIDER_T13,
      ...(input.harness === "pi" ? [PI_JUDGE_ROUTE] : []),
    ],
  };
}

/**
 * Compiles `input`; see the module comment. `version` is the compiler version named in the
 * header and hashed with the input: {@link COMPILER_VERSION} unless pinned (the goldens pin
 * it, so a lockstep version bump does not rewrite them).
 */
export function compilePolicy(
  input: CompileInput,
  version: string = COMPILER_VERSION,
): CompiledPolicy {
  const judgeHosts = judgeHostsOf(input);
  const f = fragmentsOf(input, judgeHosts);
  const policy = assemble(f);
  const refusals = refusalsOf(f, policy, judgeHosts);
  const backs = {
    protection: backsOf(input.policies, "protection"),
    task: backsOf(input.policies, "task-allowlist"),
  };
  const hash = inputsHash(normalized(input, version));
  const meta = {
    version,
    inputsHash: hash,
    backs: commentMap(policy, backs.protection, backs.task),
  };
  const refused = refusals.length > 0;
  return {
    policy: refused ? null : policy,
    yaml: refused ? null : emitPolicy(policy, meta),
    updates: refused ? [] : f.task.updates,
    ...reportOf(input, f, backs),
    refusals,
    judgeHosts,
    inputsHash: hash,
  };
}
