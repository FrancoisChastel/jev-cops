import type {
  PiApi,
  PiContext,
  PiHandler,
  PiToolCallEvent,
  PiToolCallResult,
  PiToolResultEvent,
  PiToolResultPatch,
} from "../pi-types.ts";

type Content = PiToolResultEvent["content"];

/**
 * A stand-in for Pi's `ExtensionRunner` + `AgentSession` tool hooks, mirroring v0.87.1:
 * - `tool_call` handlers run in registration order; the first result with `block` wins;
 *   a handler that throws blocks the tool ("A `tool_call` handler failure blocks the
 *   tool as a fail-safe"); handlers mutate `event.input` in place to rewrite.
 * - `tool_result` handlers compose: each sees the content the previous one returned;
 *   a throwing handler is reported and skipped.
 */
export class FakePi implements PiApi {
  private readonly handlers = new Map<string, PiHandler<never>[]>();
  readonly errors: string[] = [];

  on(event: string, handler: PiHandler<never>): () => void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, [...list, handler]);
    return () =>
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((h) => h !== handler),
      );
  }

  private list<E>(event: string): PiHandler<E>[] {
    return (this.handlers.get(event) ?? []) as PiHandler<E>[];
  }

  async sessionStart(reason: string, ctx: PiContext): Promise<void> {
    for (const h of this.list<{ type: "session_start"; reason: string }>("session_start")) {
      await h({ type: "session_start", reason }, ctx);
    }
  }

  async beforeAgentStart(prompt: string, ctx: PiContext): Promise<void> {
    for (const h of this.list<{ type: "before_agent_start"; prompt: string }>(
      "before_agent_start",
    )) {
      await h({ type: "before_agent_start", prompt }, ctx);
    }
  }

  async toolCall(event: PiToolCallEvent, ctx: PiContext): Promise<PiToolCallResult | undefined> {
    let result: PiToolCallResult | undefined;
    for (const h of this.list<PiToolCallEvent>("tool_call")) {
      try {
        const out = (await h(event, ctx)) as PiToolCallResult | undefined;
        if (out === undefined) continue;
        result = out;
        if (out.block === true) return out;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { block: true, reason: message };
      }
    }
    return result;
  }

  async toolResult(event: PiToolResultEvent, ctx: PiContext): Promise<Content> {
    let content = event.content;
    for (const h of this.list<PiToolResultEvent>("tool_result")) {
      try {
        const out = (await h({ ...event, content }, ctx)) as PiToolResultPatch | undefined;
        if (out?.content !== undefined) content = out.content;
      } catch (cause) {
        this.errors.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
    return content;
  }

  /**
   * One tool call end to end: `tool_call`, then (unless blocked) `tool_result` with
   * `output` as the tool's text. Returns the pre-hook verdict, the input as it ran
   * (after in-place rewrites) and the content the model would see.
   */
  async run(
    ctx: PiContext,
    toolName: string,
    input: Record<string, unknown>,
    output = "",
  ): Promise<{
    blocked: PiToolCallResult | undefined;
    input: Record<string, unknown>;
    content: Content;
  }> {
    const toolCallId = `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
    const call: PiToolCallEvent = { type: "tool_call", toolCallId, toolName, input };
    const verdict = await this.toolCall(call, ctx);
    if (verdict?.block === true) return { blocked: verdict, input: call.input, content: [] };
    const result: PiToolResultEvent = {
      type: "tool_result",
      toolCallId,
      toolName,
      input: call.input,
      content: [{ type: "text", text: output }],
      isError: false,
    };
    return { blocked: verdict, input: call.input, content: await this.toolResult(result, ctx) };
  }
}

/** What a fake context recorded: dialogs, notifications, abort/shutdown calls. */
export interface FakeContextLog {
  confirms: { title: string; message: string }[];
  notes: { message: string; type: string | undefined }[];
  aborted: number;
  shutdowns: number;
}

/**
 * A Pi `ExtensionContext` subset. `hasUI` false is print/json mode (headless); true is
 * tui/rpc with `ui.confirm` answering `confirm` (default: decline).
 */
export function fakeContext(opts: {
  cwd: string;
  sessionId?: string;
  hasUI?: boolean;
  confirm?: boolean;
  model?: string;
}): PiContext & { log: FakeContextLog } {
  const log: FakeContextLog = { confirms: [], notes: [], aborted: 0, shutdowns: 0 };
  const hasUI = opts.hasUI ?? false;
  return {
    log,
    mode: hasUI ? "tui" : "print",
    hasUI,
    cwd: opts.cwd,
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "019a0000-0000-7000-8000-000000000001",
    },
    model: opts.model === undefined ? undefined : { id: opts.model },
    ui: {
      confirm: async (title, message) => {
        log.confirms.push({ title, message });
        return opts.confirm ?? false;
      },
      notify: (message, type) => {
        log.notes.push({ message, type });
      },
    },
    abort: () => {
      log.aborted += 1;
    },
    shutdown: () => {
      log.shutdowns += 1;
    },
  };
}
