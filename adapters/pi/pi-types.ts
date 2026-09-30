/**
 * The subset of Pi's extension API (`@earendil-works/pi-coding-agent`, verified at
 * v0.87.1, `src/core/extensions/types.ts`) the jev-cops extension uses, declared locally
 * so the extension has no dependency on Pi's package. Type-only: `jev-cops.ts` imports it
 * with `import type`, which every TypeScript loader (Pi's jiti included) erases, so the
 * installed extension is still one self-contained file.
 */

/** Pi's `tool_call` event. `input` is mutable: mutating it in place is how to rewrite. */
export interface PiToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** What a `tool_call` handler may return. `terminate` is a batch-level hint only. */
export interface PiToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

/** A text or image block of a tool result. */
export type PiContent = { type: "text"; text: string } | { type: "image"; [key: string]: unknown };

/** Pi's `tool_result` event. */
export interface PiToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: PiContent[];
  isError: boolean;
}

/** What a `tool_result` handler may return; later handlers see the replaced content. */
export interface PiToolResultPatch {
  content?: PiContent[];
}

/** The subset of Pi's `ExtensionContext` the extension uses. */
export interface PiContext {
  mode: string;
  /** True in tui and rpc (dialogs available); false in print/json = headless. */
  hasUI: boolean;
  cwd: string;
  sessionManager: { getSessionId(): string };
  model?: { id: string } | undefined;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  /** Aborts the current agent operation (ends a print/json run). */
  abort(): void;
  /** Requests an orderly exit; a no-op in print/json mode at v0.87.1 (no handler bound). */
  shutdown(): void;
}

/** A Pi event handler. */
export type PiHandler<E> = (event: E, ctx: PiContext) => unknown;

/** The subset of Pi's `ExtensionAPI` the extension uses. */
export interface PiApi {
  on(event: "session_start", h: PiHandler<{ reason: string }>): unknown;
  on(event: "before_agent_start", h: PiHandler<{ prompt: string }>): unknown;
  on(event: "tool_call", h: PiHandler<PiToolCallEvent>): unknown;
  on(event: "tool_result", h: PiHandler<PiToolResultEvent>): unknown;
}

/** Where `copsd` listens, and the client-side time limits. */
export interface JevCopsOptions {
  socket: string;
  /** Judge request limit; default 13 s = the daemon's 12 s deadline + 1 s. */
  judgeTimeoutMs?: number;
  /** Post-event and resolve limit; observe never blocks the agent longer than this. */
  observeTimeoutMs?: number;
}

/** The adapter's best-effort `call.kind` for a Pi tool. */
export type PiCallKind = "exec" | "fs.read" | "fs.write" | "other";

/** A `jev-cops.verdict/1` reply reduced to what the extension acts on. */
export interface Judged {
  verdict: "allow" | "annotate" | "rewrite" | "hold" | "deny" | "kill";
  reason: string;
  note: string | null;
  input: Record<string, unknown> | null;
  /** The `hold_token` of a `hold`: presented to `/v1/resolve`, never shown to the model. */
  token: string | null;
}

/** A daemon reply: HTTP status and parsed JSON body (null when empty). */
export interface Reply {
  status: number;
  body: unknown;
}
