import { FEATURE_NAMES, type FeatureExplanation, type Features } from "../context/features.ts";
import type { Verdict } from "../schema/verdict.ts";
import type { PolicyConfig } from "./config.ts";
import type { Contribution } from "./contribute.ts";
import type { DecisionFlags, PolicyTrace } from "./decision.ts";
import type { PolicyContext, PolicyEvent } from "./types.ts";

const CONTROL = /[\p{Cc}\s]+/gu;

/** Cuts `text` to `max` characters, marking the cut with `…`. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** One trimmed line: control characters and runs of whitespace become one space. */
export function oneLine(text: string, max: number): string {
  return clip(text.replace(CONTROL, " ").trim(), max);
}

/** What the text helpers need about the event and the combination. */
export interface ExplainInput {
  e: PolicyEvent;
  ctx: PolicyContext;
  verdict: Verdict;
  contributions: ReadonlyArray<Contribution>;
  /** The budget rule raised the verdict to `hold` (it was lower before). */
  heldByBudget: boolean;
  /** The budget raised an `allow` to `annotate`. */
  annotatedByBudget: boolean;
  flags: DecisionFlags;
  config: PolicyConfig;
}

function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function policyReason(c: Contribution, input: ExplainInput): string | null {
  const { reason } = c.match.policy;
  const text =
    typeof reason === "string" ? reason : safely(() => reason(input.e, input.ctx, c.answers));
  if (typeof text !== "string") return null;
  const line = oneLine(text, input.config.texts.maxReasonChars);
  return line === "" ? null : line;
}

/**
 * The agent-safe reason: the missing-rewrite or budget sentence when those decided the
 * verdict, else the reason of the first policy whose contribution equals the verdict,
 * else the fixed band sentence for the verdict. Always one bounded line.
 */
export function reasonFor(input: ExplainInput): string {
  const { reasons } = input.config.texts;
  if (input.flags.rewriteWithoutInput) return reasons.missingRewrite;
  if (input.heldByBudget) return reasons.budget;
  for (const c of input.contributions.filter((x) => x.verdict === input.verdict)) {
    const text = policyReason(c, input);
    if (text !== null) return text;
  }
  return reasons[input.verdict];
}

/** The note injected on `annotate`: the winning policy's, the budget's, or the default. */
export function contextNoteFor(input: ExplainInput): string | null {
  if (input.verdict !== "annotate") return null;
  const { texts } = input.config;
  for (const c of input.contributions.filter((x) => x.verdict === "annotate")) {
    const note = safely(() => c.match.policy.contextNote?.(input.e, input.ctx, c.answers) ?? null);
    if (typeof note === "string" && note.trim() !== "") return clip(note, texts.maxNoteChars);
  }
  return input.annotatedByBudget ? texts.budgetNote : texts.annotateNote;
}

function traceLine(t: PolicyTrace): string {
  const marks = [
    t.fallbackUsed ? "fallback" : null,
    t.capped ? "capped at hold" : null,
    t.waived ? "waived by precedent" : null,
    t.whenOverBudget ? `when ${t.whenMs.toFixed(1)} ms over budget` : null,
    t.degraded ? "degraded" : null,
    t.note,
  ].filter((m): m is string => m !== null);
  return `${t.policy}: ${t.verdict ?? "none"}${marks.length > 0 ? ` (${marks.join("; ")})` : ""}`;
}

function featureLines(features: Readonly<Features>, why: Readonly<FeatureExplanation>): string[] {
  return FEATURE_NAMES.map((name) => {
    const evidence = why[name].length > 0 ? `: ${why[name].join("; ")}` : "";
    return `${name} ${features[name].toFixed(2)}${evidence}`;
  });
}

/** Everything `detailFor` reports besides the explain input. */
export interface DetailFacts {
  risk: number;
  floorWhy: ReadonlyArray<string>;
  features: Readonly<Features>;
  why: Readonly<FeatureExplanation>;
  budget: { spent: number; limit: number };
}

/**
 * The human-only paragraph (never sent to the agent): verdict and risk, the floor terms,
 * feature evidence, the judge outcome, one line per matched policy, policy `detail`s,
 * budget and precedent effects. Bounded by `maxDetailChars`.
 */
export function detailFor(input: ExplainInput, facts: DetailFacts): string {
  const { flags } = input;
  const policyDetails = input.contributions
    .filter((c) => c.match.matched && c.match.policy.detail !== undefined)
    .flatMap((c) => {
      const text = safely(() => c.match.policy.detail?.(input.e, input.ctx, c.answers));
      return typeof text === "string" ? [`${c.match.key} detail: ${text}`] : [];
    });
  const lines = [
    `verdict ${input.verdict} · risk ${facts.risk.toFixed(2)} · ${facts.floorWhy.join(", ")}`,
    ...featureLines(facts.features, facts.why),
    `judge: ${flags.judge} (${flags.questions} questions, floor ${flags.inBand ? "in" : "outside"} band, scope ${flags.scope})`,
    ...input.contributions.filter((c) => c.match.matched).map((c) => traceLine(c.trace)),
    ...policyDetails,
    `budget ${facts.budget.spent}/${facts.budget.limit}${flags.budgetRaised ? " · raised one step" : ""}${flags.budgetHeld ? " · holding non-trivial actions" : ""}`,
    ...(flags.precedent === "none" ? [] : [`precedent ${flags.precedent}`]),
    ...(flags.rewriteWithoutInput ? ["rewrite without a single updated_input raised to hold"] : []),
  ];
  return clip(lines.join("\n"), input.config.texts.maxDetailChars);
}
