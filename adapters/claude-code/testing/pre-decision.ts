/**
 * How Claude Code turns PreToolUse hook runs into one decision (hooks#pretooluse-decision-
 * control, #exit-code-2, #other-exit-codes; checked against a real claude 2.1.280):
 * - exit 2 blocks "whether or not you print JSON"; the reason Claude sees is the JSON
 *   `permissionDecisionReason` of a deny when there is one, else stderr;
 * - otherwise a valid JSON object decides: `deny`, `ask` (reason shown to the user),
 *   `allow` (skips the prompt), `defer` (ignored with a warning in interactive sessions);
 *   `updatedInput` replaces the input; `additionalContext` goes to Claude;
 *   a `hookSpecificOutput` for another event fails validation (non-blocking error);
 * - `continue: false` stops Claude after this call;
 * - a timeout or a non-blocking error renders no decision;
 * - across handlers, `deny` > `defer` > `ask` > `allow`, and the last `updatedInput` to
 *   finish wins.
 */
import type { HookRun } from "./hook-run.ts";

type Json = Record<string, unknown>;

/** A handler's or the combined decision. */
export interface PreDecision {
  readonly outcome: "proceed" | "allow" | "ask" | "defer" | "deny";
  /** Deny: what Claude sees. Ask: what the user sees. */
  readonly reason: string | null;
  readonly updatedInput: Json | null;
  readonly context: readonly string[];
  /** `continue: false`: Claude stops after this call. */
  readonly stop: boolean;
  readonly systemMessage: string | null;
  readonly hookErrors: readonly string[];
  readonly ms: number;
}

const RANK: Readonly<Record<PreDecision["outcome"], number>> = {
  proceed: 0,
  allow: 1,
  ask: 2,
  defer: 3,
  deny: 4,
};

const DECISIONS: ReadonlySet<string> = new Set(["allow", "deny", "ask", "defer"]);

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const NONE: Omit<PreDecision, "ms"> = {
  outcome: "proceed",
  reason: null,
  updatedInput: null,
  context: [],
  stop: false,
  systemMessage: null,
  hookErrors: [],
};

function fromJson(json: Json, run: HookRun): PreDecision {
  const hso = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  if (hso.hookEventName !== undefined && hso.hookEventName !== "PreToolUse") {
    return { ...NONE, hookErrors: ["hookSpecificOutput for another event"], ms: run.ms };
  }
  const decision = str(hso.permissionDecision);
  if (decision !== null && !DECISIONS.has(decision) && run.exitCode !== 2) {
    return { ...NONE, hookErrors: [`invalid permissionDecision ${decision}`], ms: run.ms };
  }
  const blocked = run.exitCode === 2 || decision === "deny";
  const outcome = blocked ? "deny" : ((decision as PreDecision["outcome"] | null) ?? "proceed");
  const jsonReason = str(hso.permissionDecisionReason);
  const stderr = run.stderr.trim();
  const reason =
    decision === "deny"
      ? (jsonReason ?? stderr)
      : blocked
        ? stderr
        : decision === "ask"
          ? jsonReason
          : null;
  return {
    outcome,
    reason,
    updatedInput: isRecord(hso.updatedInput) && outcome !== "defer" ? hso.updatedInput : null,
    context: str(hso.additionalContext) === null ? [] : [String(hso.additionalContext)],
    stop: json.continue === false,
    systemMessage: str(json.systemMessage),
    hookErrors: [],
    ms: run.ms,
  };
}

/** One handler's run as Claude Code reads it. */
export function decisionOf(run: HookRun): PreDecision {
  if (run.exitCode === null || run.hookError !== null) {
    return { ...NONE, hookErrors: [run.hookError ?? "hook error"], ms: run.ms };
  }
  if (run.json !== null) return fromJson(run.json, run);
  if (run.exitCode === 2)
    return { ...NONE, outcome: "deny", reason: run.stderr.trim(), ms: run.ms };
  return { ...NONE, ms: run.ms };
}

/** Every handler's decision combined, as Claude Code applies them to one tool call. */
export function combine(decisions: readonly PreDecision[]): PreDecision {
  const winner = decisions.reduce((a, b) => (RANK[b.outcome] > RANK[a.outcome] ? b : a), {
    ...NONE,
    ms: 0,
  });
  const rewrites = decisions.filter((d) => d.updatedInput !== null).sort((a, b) => a.ms - b.ms);
  return {
    ...winner,
    updatedInput: rewrites.at(-1)?.updatedInput ?? null,
    context: decisions.flatMap((d) => d.context),
    stop: decisions.some((d) => d.stop),
    systemMessage: decisions.find((d) => d.systemMessage !== null)?.systemMessage ?? null,
    hookErrors: decisions.flatMap((d) => d.hookErrors),
  };
}
