/**
 * One request of any of the three wire formats, read as the same small conversation: the
 * tools offered, and each turn's texts, tool calls and tool results. The planner needs
 * nothing more; the request log keeps the body itself.
 */

/** The wire format a request came in. */
export type Api = "anthropic" | "responses" | "chat";

/** A turn: user (prompts and tool results), assistant (text and tool calls), or other (system). */
export interface Turn {
  readonly role: "user" | "assistant" | "other";
  readonly texts: readonly string[];
  readonly toolCalls: number;
  readonly toolResults: number;
}

/** What the planner reads from a request. */
export interface Conversation {
  readonly api: Api;
  readonly model: string;
  readonly stream: boolean;
  /** The names of the tools the request offers the model. */
  readonly tools: readonly string[];
  readonly turns: readonly Turn[];
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function base(body: Json, api: Api, tools: string[], turns: Turn[]): Conversation {
  return {
    api,
    model: str(body.model) ?? "fake-model",
    stream: body.stream === true,
    tools,
    turns,
  };
}

/** Texts of a content that is a string or a list of `{type, text}` parts. */
function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return list(content).flatMap((p) => {
    const text = isObject(p) ? str(p.text) : null;
    return text === null ? [] : [text];
  });
}

function count(content: unknown, type: string): number {
  return list(content).filter((p) => isObject(p) && p.type === type).length;
}

/** Anthropic Messages API (`POST /v1/messages`). */
export function fromAnthropic(body: Json): Conversation {
  const tools = list(body.tools).flatMap((t) => {
    const name = isObject(t) ? str(t.name) : null;
    return name === null ? [] : [name];
  });
  const turns = list(body.messages).map((m): Turn => {
    const msg = isObject(m) ? m : {};
    const role = msg.role === "user" || msg.role === "assistant" ? msg.role : "other";
    const content = msg.content;
    const texts =
      typeof content === "string"
        ? [content]
        : list(content).flatMap((p) =>
            isObject(p) && p.type === "text" && typeof p.text === "string" ? [p.text] : [],
          );
    return {
      role,
      texts,
      toolCalls: count(content, "tool_use"),
      toolResults: count(content, "tool_result"),
    };
  });
  return base(body, "anthropic", tools, turns);
}

const CALL_ITEMS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const OUTPUT_ITEMS = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
]);

/** One Responses API input item as a turn (consecutive calls or outputs merge later). */
function responsesItem(item: unknown): Turn | null {
  if (!isObject(item)) return null;
  const type = str(item.type) ?? "message";
  if (CALL_ITEMS.has(type)) return { role: "assistant", texts: [], toolCalls: 1, toolResults: 0 };
  if (OUTPUT_ITEMS.has(type)) return { role: "user", texts: [], toolCalls: 0, toolResults: 1 };
  if (type !== "message") return null;
  const role = item.role === "user" || item.role === "assistant" ? item.role : "other";
  return { role, texts: contentTexts(item.content), toolCalls: 0, toolResults: 0 };
}

/** Merges a turn into the previous one when both are calls, or both are tool results. */
function merge(turns: Turn[], next: Turn): Turn[] {
  const prev = turns.at(-1);
  const bothCalls = prev?.role === "assistant" && next.toolCalls > 0;
  const bothResults = prev?.role === "user" && prev.toolResults > 0 && next.toolResults > 0;
  if (prev === undefined || !(bothCalls || bothResults)) return [...turns, next];
  const joined: Turn = {
    role: prev.role,
    texts: [...prev.texts, ...next.texts],
    toolCalls: prev.toolCalls + next.toolCalls,
    toolResults: prev.toolResults + next.toolResults,
  };
  return [...turns.slice(0, -1), joined];
}

/** OpenAI Responses API (`POST /v1/responses`). */
export function fromResponses(body: Json): Conversation {
  const tools = list(body.tools).flatMap((t) => {
    if (!isObject(t)) return [];
    const name = str(t.name) ?? str(t.type);
    return name === null ? [] : [name];
  });
  const input =
    typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  const turns = list(input)
    .map(responsesItem)
    .filter((t): t is Turn => t !== null)
    .reduce<Turn[]>(merge, []);
  return base(body, "responses", tools, turns);
}

/** One chat completions message as a turn. */
function chatMessage(m: unknown): Turn {
  const msg = isObject(m) ? m : {};
  if (msg.role === "tool") return { role: "user", texts: [], toolCalls: 0, toolResults: 1 };
  const role = msg.role === "user" || msg.role === "assistant" ? msg.role : "other";
  return {
    role,
    texts: contentTexts(msg.content),
    toolCalls: list(msg.tool_calls).length,
    toolResults: 0,
  };
}

/** OpenAI-compatible chat completions (`POST /v1/chat/completions`). */
export function fromChat(body: Json): Conversation {
  const tools = list(body.tools).flatMap((t) => {
    const fn = isObject(t) && isObject(t.function) ? t.function : null;
    const name = fn === null ? null : str(fn.name);
    return name === null ? [] : [name];
  });
  const turns = list(body.messages).map(chatMessage).reduce<Turn[]>(merge, []);
  return base(body, "chat", tools, turns);
}
