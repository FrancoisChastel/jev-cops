/**
 * @jev-cops/openshell — the OpenShell compiler and CLI wrapper (spec §OpenShell complement,
 * PLAN-M2 steps 1–2). `compilePolicy` turns the judge's inputs into one OpenShell v0.1.2
 * policy (protection set, judge route, task allowlist) with a report of what it leaves out
 * and why it would refuse; `OpenShellCli` and `sandbox.ts` drive the `openshell` binary.
 */
export * from "./argv.ts";
export * from "./cli.ts";
export * from "./compile.ts";
export * from "./diff.ts";
export * from "./emit.ts";
export * from "./findings.ts";
export { JUDGE_PROVIDER_HOSTS, judgeHostReached, t13Refusals } from "./fragments/judge-hosts.ts";
export { JUDGE_HOST, JUDGE_ROUTES, JUDGE_RULE } from "./fragments/judge-route.ts";
export { BASELINE_READ_ONLY, BASELINE_READ_WRITE } from "./fragments/protection.ts";
export {
  type GitRemote,
  REGISTRY_HOSTS,
  type RepoInput,
  TASK_RULES,
} from "./fragments/task-allowlist.ts";
export * from "./layout.ts";
export * from "./prover.ts";
export * from "./repo.ts";
export * from "./report.ts";
export * from "./sandbox.ts";
export * from "./schema.ts";
export type { Absent, PolicyUpdate } from "./types.ts";
