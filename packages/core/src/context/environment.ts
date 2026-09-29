import type { NormalizedEvent } from "../normalizer/types.ts";
import type { GitInfo } from "../schema/event.ts";
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./config.ts";

/** Exposure of the call's target in [0, 1], with the reasons that added weight. */
export interface EnvironmentScore {
  value: number;
  why: string[];
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * Branch names that count as the default branch: the configured ones (`main`, `master`)
 * always, plus the reported `default_branch` (D-068). The reported value alone can never
 * make `main` stop counting: the agent can repoint `origin/HEAD` in its own repo.
 */
export function defaultBranches(
  git: Readonly<GitInfo> | undefined,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): string[] {
  const reported = git?.default_branch;
  const always = cfg.environment.defaultBranches;
  return reported === undefined ? [...always] : [...new Set([...always, reported])];
}

/** True when the current branch is a default branch; an unknown branch is not (D-024). */
export function isOnDefaultBranch(
  git: Readonly<GitInfo> | undefined,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): boolean {
  const branch = git?.branch;
  return branch !== undefined && defaultBranches(git, cfg).includes(branch);
}

function cwdOutsideRepo(n: NormalizedEvent): boolean {
  const repo = n.event.env?.git?.repo;
  return repo === undefined || !isUnder(n.event.call.cwd, repo);
}

function hostWeight(n: NormalizedEvent, cfg: ContextConfig): { weight: number; why: string[] } {
  const { hostClasses, hostClassWeights } = cfg.environment;
  const classes = n.hosts.map((h) =>
    Object.hasOwn(hostClasses, h) ? (hostClasses[h] ?? "unknown") : "unknown",
  );
  const weight = classes.reduce((max, c) => Math.max(max, hostClassWeights[c]), 0);
  const top = classes.filter((c) => hostClassWeights[c] === weight && weight > 0);
  return { weight, why: top.length > 0 ? [`${top[0]} host`] : [] };
}

/**
 * Weighted sum of exposure signals, clamped to 1: default branch (D-068), cwd outside the repo
 * (or no repo known), dirty tree, headless mode, no sandbox (absent sandbox info counts
 * as none), and the highest credential class among the target hosts. Pure.
 */
export function environmentScore(
  n: NormalizedEvent,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): EnvironmentScore {
  const w = cfg.environment.weights;
  const env = n.event.env;
  const signals: [boolean, number, string][] = [
    [isOnDefaultBranch(env?.git, cfg), w.defaultBranch, "default branch"],
    [cwdOutsideRepo(n), w.cwdOutsideRepo, "cwd outside repo"],
    [env?.git?.dirty === true, w.dirtyTree, "dirty tree"],
    [n.event.session.mode === "headless", w.headless, "headless"],
    [env?.sandbox?.kind !== "openshell", w.noSandbox, "no sandbox"],
  ];
  const fired = signals.filter(([on, weight]) => on && weight > 0);
  const host = hostWeight(n, cfg);
  const sum = fired.reduce((s, [, weight]) => s + weight, host.weight);
  const value = Math.min(1, Math.round(sum * 1000) / 1000);
  return { value, why: [...fired.map(([, , why]) => why), ...host.why] };
}
