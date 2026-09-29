import type { NormalizedEvent } from "../normalizer/types.ts";
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./config.ts";

/** Exposure of the call's target in [0, 1], with the reasons that added weight. */
export interface EnvironmentScore {
  value: number;
  why: string[];
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function onDefaultBranch(n: NormalizedEvent, cfg: ContextConfig): boolean {
  const git = n.event.env?.git;
  if (git?.branch === undefined) return false;
  if (git.default_branch !== undefined) return git.branch === git.default_branch;
  return cfg.environment.fallbackDefaultBranches.includes(git.branch);
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
 * Weighted sum of exposure signals, clamped to 1: default branch, cwd outside the repo
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
    [onDefaultBranch(n, cfg), w.defaultBranch, "default branch"],
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
