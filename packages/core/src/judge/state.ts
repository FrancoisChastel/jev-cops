import type { Features } from "../context/features.ts";
import type { CallRecord, CaseFile } from "../context/types.ts";
import { canonicalJson } from "../normalizer/hash.ts";
import type { NormalizedEvent } from "../normalizer/types.ts";
import { DEFAULT_JUDGE_CONFIG, type JudgeStateConfig } from "./config.ts";
import type { JudgeCallSummary, JudgeState } from "./types.ts";

/**
 * Top-level tool-input fields that carry the agent's own prose about the call. They are
 * dropped before anything reaches the judge (spec: "never the agent's own explanation
 * text"), so an agent cannot argue its case to the model (T6, T8).
 */
export const AGENT_PROSE_KEYS: ReadonlySet<string> = new Set([
  "description",
  "prompt",
  "explanation",
  "reason",
  "rationale",
  "justification",
]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function list(values: ReadonlyArray<string>, cfg: JudgeStateConfig): readonly string[] {
  return Object.freeze(values.slice(0, cfg.maxList).map((v) => clip(v, cfg.maxChars)));
}

/** True when the event is a shell call whose `raw` is exactly its `command` string. */
function isShell(n: NormalizedEvent): boolean {
  const input = n.event.call.input;
  const command = Object.hasOwn(input, "command") ? input.command : undefined;
  return typeof command === "string" && n.raw === command;
}

function withoutProse(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !AGENT_PROSE_KEYS.has(key)));
}

function commandText(n: NormalizedEvent): string {
  if (isShell(n)) return n.commands.map((c) => c.argv.join(" ")).join("\n");
  return [n.event.call.tool, ...n.paths, ...n.hosts].join(" ");
}

function callSummary(c: CallRecord, cfg: JudgeStateConfig): JudgeCallSummary {
  return Object.freeze({
    kind: c.kind,
    command: clip(c.argv.join(" "), cfg.maxCallChars),
    paths: list(c.paths, cfg),
    hosts: list(c.hosts, cfg),
    ok: c.ok ?? null,
  });
}

/**
 * The state the judge sees for `n`, built field by field from the normalized event and
 * a bounded case-file summary. Never includes agent prose: for a shell call `raw` is
 * the command itself, for any other tool it is the input without {@link AGENT_PROSE_KEYS};
 * the task comes from the case file (immutable, T11), never from the event. Frozen.
 */
export function buildJudgeState(
  n: NormalizedEvent,
  cf: CaseFile,
  features: Readonly<Features>,
  cfg: JudgeStateConfig = DEFAULT_JUDGE_CONFIG.state,
): JudgeState {
  const callId = n.event.call.id;
  const recent = cf
    .recentCalls(cfg.recentWindowMs)
    .filter((c) => c.callId !== callId)
    .slice(-cfg.recentCalls);
  const raw = isShell(n) ? n.raw : canonicalJson(withoutProse(n.event.call.input));
  return Object.freeze({
    stateHash: n.stateHash,
    tool: n.event.call.tool,
    kind: n.kind,
    command: clip(commandText(n), cfg.maxChars),
    raw: clip(raw, cfg.maxChars),
    verbs: list([...new Set(n.commands.flatMap((c) => c.verbs))], cfg),
    paths: list(n.paths, cfg),
    hosts: list(n.hosts, cfg),
    opaque: Object.freeze([...new Set(n.opaque.map((o) => o.reason))]),
    features: Object.freeze({ ...features }),
    task: cf.task === null ? null : clip(cf.task, cfg.maxChars),
    casefile: Object.freeze({
      recentCalls: Object.freeze(recent.map((c) => callSummary(c, cfg))),
      secretReads: cf.secretReadsSince(0).length,
      hostsSeen: list([...cf.hostsSeen().keys()], cfg),
    }),
  });
}
