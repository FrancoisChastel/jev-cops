/**
 * Verdict → Claude Code hook output (exit code, stdout JSON, stderr), pure. The mapping only
 * ever tightens (spec; PLAN-M1 §2 rows 4–6, 9, 24; verified against a real claude 2.1.280):
 *
 * | verdict  | output |
 * |----------|--------|
 * | allow    | exit 0, no output: "no decision; normal permission flow applies" |
 * | annotate | exit 0, `additionalContext` only |
 * | rewrite  | exit 0, `updatedInput` only; permission rules run on the pinned input |
 * | hold     | a human can answer: `permissionDecision: "ask"`, reason = daemon reason + raw + detail (shown to the user, not Claude); else deny |
 * | deny     | exit 2 + JSON deny (`permissionDecisionReason`, what Claude sees) + stderr |
 * | kill     | deny + `continue: false` + `stopReason` |
 *
 * `permissionDecision: "allow"` ("skips the permission prompt") and `"defer"` (ignored on
 * multi-call turns) are never emitted. `detail` only ever reaches an `ask`.
 */
import type { SessionMode, Verdict } from "@jev-cops/core";
import { NO_HUMAN_PERMISSION_MODES, PERMISSION_MODES } from "@jev-cops/core/schema";

/** What the hook process ends with: its exit code, stdout (JSON) and stderr. */
export interface HookOutput {
  readonly exitCode: 0 | 2;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

/** A daemon verdict reduced to what the hook acts on (see verdict.ts). */
export interface Judged {
  readonly verdict: Verdict;
  /** Agent-facing reason. */
  readonly reason: string;
  /** `context_note`, for Claude's context. */
  readonly note: string | null;
  /** `updated_input` of a `rewrite`; null otherwise. */
  readonly input: Record<string, unknown> | null;
}

/** The T8 confirm view of a hold: the daemon's normalized raw command and its human detail. */
export interface ConfirmView {
  readonly raw: string;
  readonly detail: string | null;
  /** The held event, for `cops explain` (the full decision); null when the view omits it. */
  readonly eventId?: string | null;
}

/** Who could answer a prompt: the session mode and the call's permission mode. */
export interface Audience {
  readonly mode: SessionMode;
  readonly permissionMode: string | undefined;
}

/** Exit 0 with no output: no decision, Claude Code's normal permission flow applies. */
export const PROCEED: HookOutput = Object.freeze({ exitCode: 0, stdout: null, stderr: null });

const KNOWN_MODES: ReadonlySet<string> = new Set(PERMISSION_MODES);
const NO_HUMAN_MODES: ReadonlySet<string> = new Set(NO_HUMAN_PERMISSION_MODES);

/** Every agent- or user-facing line jev-cops writes starts with this. */
const tag = (text: string) => `jev-cops: ${text}`;

/**
 * True when a human can answer an `ask`: an interactive session whose permission mode
 * prompts. `dontAsk` and `bypassPermissions` never prompt, and a mode jev-cops does not know
 * counts as "no human" (D-078); headless `-p` runs deny an ask they have no host for, and
 * then show its reason to Claude (observed on 2.1.280), so they never get one (D-008).
 */
export function humanCanAnswer(a: Audience): boolean {
  if (a.mode !== "interactive") return false;
  if (a.permissionMode === undefined) return true;
  return KNOWN_MODES.has(a.permissionMode) && !NO_HUMAN_MODES.has(a.permissionMode);
}

/**
 * The text of an `ask` prompt, shown to the user and not to Claude
 * (hooks#pretooluse-decision-control): the reason, the daemon's normalized command, its
 * detail, and where to read the full decision. Never the tool input's own prose (T8).
 */
export function askText(reason: string, view: ConfirmView): string {
  const command = `Command, as jev-cops normalized it:\n${view.raw}`;
  const explain = view.eventId ? [`Full decision: cops explain ${view.eventId}`] : [];
  const parts = [
    `jev-cops hold: ${reason}`,
    command,
    ...(view.detail === null ? [] : [view.detail]),
    ...explain,
  ];
  return parts.join("\n\n");
}

function preToolUse(fields: Record<string, unknown>, top: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...top, hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
}

function contextOf(note: string | null): Record<string, string> {
  return note === null ? {} : { additionalContext: tag(note) };
}

/**
 * A blocked tool call: exit 2 (the only code that blocks, and immune to allow rules and to
 * other hooks' `allow`) plus the same reason as JSON deny and on stderr. `kill` adds
 * `continue: false` so Claude stops after this call; `stopReason` is the reason.
 */
export function blockTool(reason: string, note: string | null = null, kill = false): HookOutput {
  const shown = tag(reason);
  const decision = { permissionDecision: "deny", permissionDecisionReason: shown };
  const stop = kill ? { continue: false, stopReason: shown } : {};
  return {
    exitCode: 2,
    stdout: preToolUse({ ...decision, ...contextOf(note) }, stop),
    stderr: shown,
  };
}

function holdOutput(v: Judged, a: Audience, view: ConfirmView | null): HookOutput {
  if (!humanCanAnswer(a)) return blockTool(v.reason, v.note);
  if (view === null) {
    return blockTool(`${v.reason} (confirmation view unavailable; blocking)`, v.note);
  }
  const ask = { permissionDecision: "ask", permissionDecisionReason: askText(v.reason, view) };
  return { exitCode: 0, stdout: preToolUse({ ...ask, ...contextOf(v.note) }), stderr: null };
}

function proceedWith(fields: Record<string, unknown>): HookOutput {
  if (Object.keys(fields).length === 0) return PROCEED;
  return { exitCode: 0, stdout: preToolUse(fields), stderr: null };
}

/**
 * The hook output for verdict `v` of a `PreToolUse`, for audience `a`. `view` is the hold's
 * confirm view; without it a hold is blocked rather than asked with less than the spec's
 * "normalized raw command and the daemon's detail" (T8).
 */
export function toHookOutput(v: Judged, a: Audience, view: ConfirmView | null): HookOutput {
  switch (v.verdict) {
    case "allow":
    case "annotate":
      return proceedWith(contextOf(v.note));
    case "rewrite":
      if (v.input === null) return blockTool(`${v.reason} (rewrite without its input)`, v.note);
      return proceedWith({ updatedInput: v.input, ...contextOf(v.note) });
    case "hold":
      return holdOutput(v, a, view);
    case "deny":
      return blockTool(v.reason, v.note);
    case "kill":
      return blockTool(v.reason, v.note, true);
  }
}

/** A read-only or inert tool proceeds while the daemon is unavailable (T2 observe class). */
export function failOpen(message: string): HookOutput {
  const shown = tag(message);
  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: shown }), stderr: shown };
}

/** Exit 2 with the reason on stderr: blocks a tool call, a prompt or a config change. */
export function failClosed(message: string): HookOutput {
  return { exitCode: 2, stdout: null, stderr: tag(message) };
}

/** Exit 0 with a note on stderr only (Claude Code's debug log): nothing for the user or Claude. */
export function quiet(message: string): HookOutput {
  return { exitCode: 0, stdout: null, stderr: tag(message) };
}

/** Exit 0 with a warning for the user (`systemMessage`) and the debug log. */
export function warn(message: string): HookOutput {
  const shown = tag(message);
  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: shown }), stderr: shown };
}

function blockDecision(reason: string): HookOutput {
  const shown = tag(reason);
  return {
    exitCode: 2,
    stdout: JSON.stringify({ decision: "block", reason: shown }),
    stderr: shown,
  };
}

/** Blocks a prompt (UserPromptSubmit): it is erased from context; the user sees the reason. */
export function blockPrompt(reason: string): HookOutput {
  return blockDecision(reason);
}

/** Blocks a settings change (ConfigChange): not applied to the running session. */
export function blockConfig(reason: string): HookOutput {
  return blockDecision(reason);
}
