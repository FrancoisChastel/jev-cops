/**
 * The request log: one JSON line per request, the ground truth of what the model saw.
 * Credentials never reach it: auth headers become facts (`absent`, `dummy`, `other`), and
 * every other header is kept. The body is kept whole except the bulky, harness-owned parts
 * (system prompt, instructions, tool schemas), which become a length, a SHA-256 and the tool
 * names; the messages the model reads are kept verbatim.
 */
import { createHash } from "node:crypto";
import type { Api } from "./conversation.ts";
import type { Reply } from "./plan.ts";

/** Headers that carry credentials: never logged. */
export const AUTH_HEADERS: readonly string[] = [
  "authorization",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "cookie",
];

/** What an auth header held, never its value. */
export type AuthFact = "absent" | "dummy" | "other";

/** The logged headers and the auth facts. */
export interface HeaderFacts {
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: Readonly<Record<string, AuthFact>>;
}

function fact(value: string | null, dummy: string): AuthFact {
  if (value === null) return "absent";
  if (dummy === "") return "other";
  return value === dummy || value === `Bearer ${dummy}` ? "dummy" : "other";
}

/** Splits request headers into loggable headers and auth facts. */
export function headerFacts(h: Headers, dummy: string): HeaderFacts {
  const headers: Record<string, string> = {};
  for (const [k, v] of h.entries()) if (!AUTH_HEADERS.includes(k)) headers[k] = v;
  const auth: Record<string, AuthFact> = {};
  for (const k of AUTH_HEADERS) auth[k] = fact(h.get(k), dummy);
  return { headers, auth };
}

/** A long harness-owned text as its size and hash. */
export function digest(value: unknown): { chars: number; sha256: string } {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { chars: text.length, sha256: createHash("sha256").update(text).digest("hex") };
}

type Json = Record<string, unknown>;

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((t: unknown) => {
    if (typeof t !== "object" || t === null) return "?";
    const o = t as Json;
    const fn = typeof o.function === "object" && o.function !== null ? (o.function as Json) : {};
    const name = o.name ?? fn.name ?? o.type;
    return typeof name === "string" ? name : "?";
  });
}

/** Chat messages with system/developer prompts condensed (they are the harness's own). */
function condenseChatMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m: unknown) => {
    const o = typeof m === "object" && m !== null ? (m as Json) : {};
    const bulky = o.role === "system" || o.role === "developer";
    return bulky ? { role: o.role, content: digest(o.content) } : m;
  });
}

/** The body as logged: system, instructions and tool schemas condensed. */
export function condenseBody(api: Api | "other", body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const b = body as Json;
  const out: Json = { ...b };
  if ("tools" in b) out.tools = toolNames(b.tools);
  if (api === "anthropic" && "system" in b) out.system = digest(b.system);
  if (api === "responses" && "instructions" in b) out.instructions = digest(b.instructions);
  if (api === "chat") out.messages = condenseChatMessages(b.messages);
  return out;
}

/** The reply as logged. */
export function replySummary(reply: Reply | null): Json | null {
  if (reply === null) return null;
  if (reply.kind === "call") {
    return {
      kind: "call",
      scenario: reply.scenario,
      step: reply.step,
      tool: reply.tool,
      input: reply.input,
    };
  }
  return {
    kind: "text",
    scenario: reply.scenario,
    step: reply.step,
    why: reply.why,
    text: reply.text,
  };
}

/** One request log line. */
export interface LogLine {
  readonly seq: number;
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly api: Api | "other";
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: Readonly<Record<string, AuthFact>>;
  readonly body: unknown;
  readonly status: number;
  readonly reply: Json | null;
}
