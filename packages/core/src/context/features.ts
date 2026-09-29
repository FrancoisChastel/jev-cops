import type { NormalizedEvent } from "../normalizer/types.ts";
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./config.ts";
import { environmentScore } from "./environment.ts";
import { reversibilityScore } from "./reversibility.ts";
import { type RepoHints, scopeScore } from "./scope.ts";
import { sequenceScore } from "./sequence.ts";
import { taintFraction } from "./taint.ts";
import type { CaseFile } from "./types.ts";

/** The five context features, in the spec's order. */
export const FEATURE_NAMES = [
  "taint",
  "scope",
  "sequence",
  "environment",
  "reversibility",
] as const;

/** One of {@link FEATURE_NAMES}. */
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Every feature in [0, 1] (spec §Context model). */
export type Features = Record<FeatureName, number>;

/** Human-readable evidence per feature; ends up in `detail`, never sent to the agent. */
export type FeatureExplanation = Record<FeatureName, string[]>;

/** Features, their evidence, and whether the deterministic scope layer was unsure. */
export interface FeatureResult {
  features: Features;
  why: FeatureExplanation;
  /** True when only soft scope rules fired: the one case the judge may be asked. */
  scopeUnsure: boolean;
}

/** Per-call inputs the daemon knows but the event does not carry. */
export interface FeatureOptions {
  repoHints?: RepoHints;
}

const MAX_WHY = 120;
const MAX_LINES = 6;

function short(lines: ReadonlyArray<string>): string[] {
  const clipped = lines.map((l) => (l.length > MAX_WHY ? `${l.slice(0, MAX_WHY - 1)}…` : l));
  if (clipped.length <= MAX_LINES) return clipped;
  return [...clipped.slice(0, MAX_LINES - 1), `… ${clipped.length - MAX_LINES + 1} more`];
}

function clamp01(value: number): number {
  return Number.isNaN(value) ? 1 : Math.min(1, Math.max(0, value));
}

/**
 * All five features for a pre event against its case file. Pure and deterministic: it
 * only reads the case file (call it before `recordPre`, or after; the event's own record
 * is never its own history), and nothing an agent can write into command text or file
 * content changes a value except through the spec's rules (T6).
 */
export function computeFeatures(
  n: NormalizedEvent,
  cf: CaseFile,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
  opts: FeatureOptions = {},
): FeatureResult {
  const taint = taintFraction(n, cf, cfg);
  const scope = scopeScore(n, cf, cfg, opts.repoHints);
  const sequence = sequenceScore(n, cf, cfg);
  const environment = environmentScore(n, cfg);
  const reversibility = reversibilityScore(n, cf, cfg);
  return {
    features: {
      taint: clamp01(taint.value),
      scope: clamp01(scope.value),
      sequence: clamp01(sequence.value),
      environment: clamp01(environment.value),
      reversibility: clamp01(reversibility.value),
    },
    why: {
      taint: short(taint.matched.map((m) => `from tool output: ${m}`)),
      scope: short(scope.why),
      sequence: short(sequence.why),
      environment: short(environment.why),
      reversibility: short(reversibility.why),
    },
    scopeUnsure: scope.unsure,
  };
}
