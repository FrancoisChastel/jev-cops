/**
 * A fake Claude Code session for end-to-end tests of the command hook: it builds the
 * documented stdin payloads, spawns the registered hook(s) as real subprocesses
 * (hook-run.ts) and applies their output the way Claude Code does (pre-decision.ts and
 * the per-event rules of hooks#exit-code-2-behavior-per-event). What reaches Claude, what
 * reaches the user and what a tool actually ran with are recorded, so tests can assert
 * the spec's outcomes on them. Tools do not run: the test supplies their response.
 */
import { randomUUID } from "node:crypto";
import { type HookCommand, type HookRun, readStdout, spawnHook } from "./hook-run.ts";
import { combine, decisionOf, type PreDecision } from "./pre-decision.ts";

type Json = Record<string, unknown>;

/** Hook timeouts in seconds, as `jevdict install` registers them (PLAN-M1 §4.3). */
export const INSTALLED_TIMEOUTS_S: Readonly<Record<string, number>> = {
  PreToolUse: 30,
  PostToolUse: 15,
  PostToolUseFailure: 15,
  UserPromptSubmit: 10,
  ConfigChange: 10,
  SessionStart: 10,
  SessionEnd: 10,
};

/** A session's setup. `hooks` are the PreToolUse handlers; the first also handles the rest. */
export interface FakeClaudeOptions {
  readonly hooks: readonly HookCommand[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly headless?: boolean;
  readonly permissionMode?: string;
  readonly sessionId?: string;
  /** The human's answer to an `ask` (interactive only); default: decline. */
  readonly answer?: (reason: string) => boolean;
  readonly timeoutsS?: Readonly<Record<string, number>>;
}

/** What one tool call did. */
export interface ToolCall {
  readonly decision: PreDecision;
  /** The input the tool ran with (after `updatedInput`), or null when it did not run. */
  readonly ran: Json | null;
  /** The tool result Claude sees (the tool's output, or the block reason). */
  readonly result: string;
  readonly post: HookRun | null;
}

/** What a session event did; `blocked` only for events that can block. */
export interface EventResult {
  readonly run: HookRun;
  readonly blocked: boolean;
  readonly shown: string | null;
}

/** The user's rejection text Claude Code returns for a declined prompt. */
export const DECLINED = "The user doesn't want to proceed with this tool use.";

export class FakeClaudeCode {
  readonly sessionId: string;
  /** Tool results, block reasons and context, in the order Claude would read them. */
  readonly claudeSees: string[] = [];
  /** Prompts, system messages and block reasons shown to the human. */
  readonly userSees: string[] = [];
  /** Set by `continue: false`: Claude stopped; a new prompt starts the next turn. */
  turnEnded = false;

  constructor(private readonly o: FakeClaudeOptions) {
    this.sessionId = o.sessionId ?? randomUUID();
  }

  private common(event: string, agentId?: string): Json {
    return {
      session_id: this.sessionId,
      transcript_path: `/tmp/fake-claude/${this.sessionId}.jsonl`,
      cwd: this.o.cwd,
      permission_mode: this.o.permissionMode ?? "default",
      hook_event_name: event,
      ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: "Explore" }),
    };
  }

  /** Runs `hook` (default: the first registered) on one payload. */
  run(event: string, payload: Json, hook = this.o.hooks[0]): Promise<HookRun> {
    if (hook === undefined) throw new Error("no hook registered");
    const timeoutS = this.o.timeoutsS?.[event] ?? INSTALLED_TIMEOUTS_S[event] ?? 600;
    const opts = { env: this.o.env, cwd: this.o.cwd, timeoutS, headless: this.o.headless ?? false };
    return spawnHook(hook, JSON.stringify(payload), opts);
  }

  private async decide(tool: string, input: Json, id: string, agentId?: string) {
    const payload = {
      ...this.common("PreToolUse", agentId),
      tool_name: tool,
      tool_input: input,
      tool_use_id: id,
    };
    const runs = await Promise.all(this.o.hooks.map((h) => this.run("PreToolUse", payload, h)));
    const d = combine(runs.map(decisionOf));
    if (d.systemMessage !== null) this.userSees.push(d.systemMessage);
    if (d.stop) this.turnEnded = true;
    return d;
  }

  /** Claude calls `tool`: PreToolUse, then (unless blocked) the tool and PostToolUse(Failure). */
  async tool(
    tool: string,
    input: Json,
    response: unknown = "",
    opts: { agentId?: string; error?: string } = {},
  ): Promise<ToolCall> {
    const id = `toolu_${randomUUID().replaceAll("-", "")}`;
    const d = await this.decide(tool, input, id, opts.agentId);
    const blockedWith = this.blockReason(d);
    if (blockedWith !== null) {
      this.claudeSees.push(blockedWith, ...d.context);
      return { decision: d, ran: null, result: blockedWith, post: null };
    }
    const ran = d.updatedInput ?? input;
    const event = opts.error === undefined ? "PostToolUse" : "PostToolUseFailure";
    const outcome = opts.error === undefined ? { tool_response: response } : { error: opts.error };
    const post = await this.run(event, {
      ...this.common(event, opts.agentId),
      tool_name: tool,
      tool_input: ran,
      tool_use_id: id,
      ...outcome,
    });
    const result =
      opts.error ?? (typeof response === "string" ? response : JSON.stringify(response));
    this.claudeSees.push(
      result,
      ...d.context,
      ...(post.exitCode === 2 ? [post.stderr.trim()] : []),
    );
    return { decision: d, ran, result, post };
  }

  /** The reason a decision blocks the call, or null when the tool runs. */
  private blockReason(d: PreDecision): string | null {
    if (d.outcome === "deny") return d.reason ?? "";
    if (d.outcome !== "ask") return null;
    // A host-less `-p` run denies the ask and hands its reason to Claude (seen on 2.1.280).
    if (this.o.headless === true) return d.reason ?? "";
    this.userSees.push(d.reason ?? "");
    return (this.o.answer ?? (() => false))(d.reason ?? "") ? null : DECLINED;
  }

  private async event(event: string, fields: Json, canBlock: boolean): Promise<EventResult> {
    const run = await this.run(event, { ...this.common(event), ...fields });
    const json = readStdout(run.stdout).json;
    const system = typeof json?.systemMessage === "string" ? json.systemMessage : null;
    if (system !== null) this.userSees.push(system);
    const blocked =
      canBlock && run.exitCode !== null && (run.exitCode === 2 || json?.decision === "block");
    const reason = typeof json?.reason === "string" ? json.reason : run.stderr.trim();
    return { run, blocked, shown: blocked ? reason : null };
  }

  /** The user submits a prompt; a block erases it and shows the reason to the user only. */
  async prompt(text: string): Promise<EventResult> {
    const r = await this.event("UserPromptSubmit", { prompt: text }, true);
    if (r.blocked) this.userSees.push(r.shown ?? "");
    if (!r.blocked) this.turnEnded = false;
    return r;
  }

  /** A settings file changed on disk; `policy_settings` changes cannot be blocked. */
  async configChange(source: string, filePath: string): Promise<EventResult> {
    return this.event(
      "ConfigChange",
      { source, file_path: filePath },
      source !== "policy_settings",
    );
  }

  sessionStart(source = "startup", model = "claude-opus-5"): Promise<EventResult> {
    return this.event("SessionStart", { source, model }, false);
  }

  sessionEnd(reason = "other"): Promise<EventResult> {
    return this.event("SessionEnd", { reason }, false);
  }
}
