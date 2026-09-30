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

/** `name@version detail: …` for each of `cs` whose policy has a `detail` that returns text. */
function policyDetailLines(cs: ReadonlyArray<Contribution>, input: ExplainInput): string[] {
  return cs.flatMap((c) => {
    const text = safely(() => c.match.policy.detail?.(input.e, input.ctx, c.answers));
    return typeof text === "string" ? [`${c.match.key} detail: ${text}`] : [];
  });
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
  const policyDetails = policyDetailLines(
    input.contributions.filter((c) => c.match.matched),
    input,
  );
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

/** The budget's one-step raise, in words (the detail says "raised one step"). */
const BUDGET_RAISED = "most of the session's risk budget is spent; the verdict was raised one step";

/**
 * What set the verdict when no matched policy returned it: the missing-rewrite or budget
 * sentence, the budget's one-step raise, or the risk band's sentence. Null when a policy
 * did. Words only: the band and the budget are named, never their figures.
 */
function causeLine(input: ExplainInput): string | null {
  const { flags, verdict } = input;
  const { reasons } = input.config.texts;
  if (flags.rewriteWithoutInput) return `rewrite: ${reasons.missingRewrite}`;
  if (input.heldByBudget) return `risk budget: ${reasons.budget}`;
  if (input.contributions.some((c) => c.verdict === verdict)) return null;
  if (flags.budgetRaised) return `risk budget: ${BUDGET_RAISED}`;
  return `risk band: ${reasons[verdict]}`;
}

/** `name@version: verdict` of one matched policy; a precedent's waiver is named. */
function summaryLine(c: Contribution): string {
  if (c.trace.waived) return `${c.match.key}: ${c.trace.verdict ?? "none"} (waived by precedent)`;
  return `${c.match.key}: ${c.verdict ?? "none"}`;
}

/**
 * The human confirm prompt's summary of a decision, one line each: every matched policy
 * as `name@version: verdict`, the `detail` of each matched policy whose contribution is
 * the final verdict, and {@link causeLine} when the band, the budget or a missing rewrite
 * set the verdict. Nothing scored: no feature value or its evidence (taint included), no
 * floor, risk, judge answer or budget figure; those stay in {@link detailFor}, which
 * `cops explain` shows. The prompt lands where the agent can read it (Claude Code keeps an
 * ask's text in its session transcript), so a policy's `detail` must be plain language
 * too. Control characters in a policy's text cannot start another line.
 */
export function confirmLinesFor(input: ExplainInput): string[] {
  const matched = input.contributions.filter((c) => c.match.matched);
  const atVerdict = matched.filter((c) => c.verdict === input.verdict);
  const cause = causeLine(input);
  const lines = [
    ...matched.map(summaryLine),
    ...policyDetailLines(atVerdict, input),
    ...(cause === null ? [] : [cause]),
  ];
  return lines.map((line) => oneLine(line, input.config.texts.maxDetailChars));
}
