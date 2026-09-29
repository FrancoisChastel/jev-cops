import {
  type Answer,
  findPromptLikeStrings,
  findSecretPatterns,
  type JevAnswer,
  type Judgement,
  type PostEvent,
  type PreEvent,
  type RepoHints,
  type Verdict,
} from "@jevdict/core";
import type { EnforcementMode } from "./config.ts";

/** The audit flag T6 asks for: the judged state carried text aimed at the judge. */
export const PROMPT_LIKE_FLAG = "prompt-like-string";

/** `{ flags, prompt_like }` when any text matches a prompt-like pattern, else `{}`. */
export function promptFlags(texts: readonly string[]): {
  flags?: string[];
  prompt_like?: string[];
} {
  const names = [...new Set(texts.flatMap((t) => findPromptLikeStrings(t)))];
  return names.length === 0 ? {} : { flags: [PROMPT_LIKE_FLAG], prompt_like: names };
}

/**
 * What the harness received for a judged event (never `detail`, never the raw hold
 * token; scores as stripped for agent channels, the full ones are under `decision`).
 */
export interface ReturnedVerdict {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly context_note: string | null;
  readonly updated_input: Record<string, unknown> | null;
  readonly risk?: number;
  readonly features?: Readonly<Record<string, number>>;
  readonly jev?: readonly JevAnswer[];
  /** First hex characters of the SHA-256 of the hold token, when one was issued. */
  readonly hold_token_sha256?: string;
}

/** Everything a `judge` audit line is built from. */
export interface JudgeRecord {
  readonly event: PreEvent;
  readonly judgement: Judgement;
  /** The judge's full typed answers (for replay); null when it was not asked or failed. */
  readonly answers: Readonly<Record<string, Answer>> | null;
  readonly returned: ReturnedVerdict;
  /** Daemon mappings applied after the engine: `headlessHoldDenied`, `observe`. */
  readonly mapping: readonly string[];
  readonly enforcement: EnforcementMode;
  readonly home: string;
  readonly repoHints: RepoHints | null;
}

/**
 * The payload of a `judge` line: the verbatim pre event, the full engine decision
 * (including the human `detail`, trace and flags, minus the internal `nextBudget`), the
 * features' evidence, the normalized reading, the judge's answers, what the harness got,
 * and the T6 flag when the raw command carries a prompt-like string. `explain` and
 * `replay` read only this.
 */
export function judgePayload(r: JudgeRecord): Record<string, unknown> {
  const { decision, normalized: n, features } = r.judgement;
  const { nextBudget: _internal, ...kept } = decision;
  return {
    event: r.event,
    raw: n.raw,
    stateHash: n.stateHash,
    normalized: {
      kind: n.kind,
      paths: n.paths,
      hosts: n.hosts,
      opaque: n.opaque,
      argv: n.commands.map((c) => c.argv),
    },
    decision: kept,
    why: features.why,
    answers: r.answers,
    returned: r.returned,
    mapping: r.mapping,
    enforcement: r.enforcement,
    home: r.home,
    repo_hints: r.repoHints,
    ...promptFlags([n.raw]),
  };
}

/**
 * The payload of an `observe` line. The post event is kept with its `result` reduced to
 * `ok`, `exit_code`, `stdout_sha256` and `bytes_out`: `stdout_head` never reaches the log
 * (spec: "secrets are not copied"). Only the *names* of secret patterns found in the head
 * are recorded, plus the T6 flag when the head or the command reads like a prompt.
 */
export function observePayload(event: PostEvent): Record<string, unknown> {
  const head = event.result.stdout_head ?? "";
  const { stdout_head: _dropped, ...result } = event.result;
  const command = typeof event.call.input.command === "string" ? event.call.input.command : "";
  return {
    event: { ...event, result },
    head_chars: head.length,
    secret_patterns: findSecretPatterns(head),
    ...promptFlags([head, command]),
  };
}
