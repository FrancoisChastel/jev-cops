#!/usr/bin/env bun
/**
 * Assertions over the artifacts a live run copies out of the containers (never over a
 * running harness): the jev-cops audit log and the fake API's request log and raw bodies.
 *
 *   bun scripts/live/check.ts judge <audit.jsonl> <tool|*> <substring> [verdict]
 *   bun scripts/live/check.ts saw <requests.jsonl> <scenario|*> <substring>
 *   bun scripts/live/check.ts leaks <bodies-dir>
 *
 * Each prints its evidence (one short line per match) and exits 0 when the expectation
 * holds, 1 when it does not, 2 on usage errors. `leaks` holds when nothing a model received
 * carries what only humans may see (scores, the confirm summary, `cops explain` ids).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;

function parseLines(text: string): Json[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        const v: unknown = JSON.parse(l);
        return typeof v === "object" && v !== null && !Array.isArray(v) ? [v as Json] : [];
      } catch {
        return [];
      }
    });
}

/** One judged call, as the evidence line prints it. */
export interface Judged {
  readonly seq: number;
  readonly eventId: string;
  readonly sessionId: string;
  readonly mode: string;
  readonly tool: string;
  readonly input: string;
  readonly verdict: string;
  readonly policies: readonly string[];
  readonly reason: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

function obj(v: unknown): Json {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

/** Every `judge` line of an audit log (`payload.event`, `.decision`, `.returned`). */
export function judged(auditText: string): Judged[] {
  return parseLines(auditText)
    .filter((l) => l.kind === "judge")
    .map((l) => {
      const p = obj(l.payload);
      const event = obj(p.event);
      const call = obj(event.call);
      const decision = obj(p.decision);
      const returned = obj(p.returned);
      const policies = decision.policies;
      // A call of a latched session is answered from the latch: no decision, no policy.
      const latched = p.latched !== undefined;
      return {
        seq: typeof l.seq === "number" ? l.seq : -1,
        eventId: str(l.event_id),
        sessionId: str(l.session_id),
        mode: str(obj(event.session).mode),
        tool: str(call.tool),
        input: str(call.input),
        verdict: str(decision.verdict ?? returned.verdict),
        policies: latched ? ["latched"] : Array.isArray(policies) ? policies.map(str) : [],
        reason: str(returned.reason),
      };
    });
}

/** Judged calls on `tool` (or any, for `*`) whose input contains `needle`. */
export function findJudged(auditText: string, tool: string, needle: string): Judged[] {
  return judged(auditText).filter(
    (j) => (tool === "*" || j.tool === tool) && j.input.includes(needle),
  );
}

export function judgedLine(j: Judged): string {
  const policies = j.policies.length === 0 ? "no policy" : j.policies.join(", ");
  return `seq ${j.seq} ${j.eventId} ${j.mode} ${j.tool} ${j.input} → ${j.verdict} (${policies})${j.reason === "" ? "" : ` "${j.reason}"`}`;
}

/** A logged request whose body contains the needle, planned for the scenario (or `*`). */
export function sawIn(requestsText: string, scenario: string, needle: string): string[] {
  return parseLines(requestsText).flatMap((l) => {
    const reply = (l.reply ?? {}) as Json;
    if (scenario !== "*" && reply.scenario !== scenario) return [];
    const body = JSON.stringify(l.body ?? null);
    const at = body.indexOf(JSON.stringify(needle).slice(1, -1));
    if (at === -1) return [];
    const snippet = body.slice(Math.max(0, at - 60), at + needle.length + 60);
    return [
      `request ${str(l.seq)} ${str(l.path)} (${str(reply.scenario)} step ${str(reply.step)}): …${snippet}…`,
    ];
  });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return str(content);
  return content.map((c) => (typeof c === "string" ? c : str(obj(c).text ?? c))).join("\n");
}

/** One message or input item of the model's last turn, as a short line (system: none). */
function itemLines(item: unknown): string[] {
  const it = obj(item);
  if (it.role === "system" || it.role === "developer") return [];
  if (it.type === "function_call_output")
    return [`function_call_output: ${clip(str(it.output), 400)}`];
  if (it.role === "tool") return [`tool result: ${clip(contentText(it.content), 400)}`];
  if (typeof it.content === "string") return [`text: ${clip(it.content, 300)}`];
  if (!Array.isArray(it.content)) return [];
  return it.content.flatMap((b) => {
    const block = obj(b);
    if (block.type === "tool_result") {
      const err = block.is_error === true ? " (is_error)" : "";
      return [`tool_result${err}: ${clip(contentText(block.content), 400)}`];
    }
    const text = str(block.text);
    return text === "" ? [] : [`text: ${clip(text, 300)}`];
  });
}

/** The items of a request after the model's last turn: what it reads next. */
export function lastTurn(body: unknown): string[] {
  const b = obj(body);
  const list: unknown[] = Array.isArray(b.messages)
    ? b.messages
    : Array.isArray(b.input)
      ? b.input
      : [];
  let start = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const it = obj(list[i]);
    if (it.role === "assistant" || it.type === "function_call") break;
    start = i;
  }
  return list.slice(start).flatMap(itemLines);
}

/** For each request planned for the scenario: what the model read in it, and its answer. */
export function modelSaw(requestsText: string, scenario: string): string[] {
  return parseLines(requestsText).flatMap((l) => {
    const reply = obj(l.reply);
    if (reply.scenario !== scenario) return [];
    const answer =
      reply.kind === "call"
        ? `call ${str(reply.tool)} ${str(reply.input)}`
        : `text "${str(reply.text)}"`;
    return [
      `request ${str(l.seq)} (step ${str(reply.step)}) → ${answer}`,
      ...lastTurn(l.body).map((line) => `  ${line}`),
    ];
  });
}

/**
 * What only a human may see (D-066, D-096): the daemon's scored detail, the confirm
 * summary, the explain pointer. The reason and a context note may reach the model.
 */
export const HUMAN_ONLY: ReadonlyArray<readonly [RegExp, string]> = [
  [/cops explain evt_/, "a `cops explain <event-id>` pointer"],
  [/Full decision:/, "the confirm view's explain line"],
  [/Command, as jev-cops normalized it:/, "the confirm view's command block"],
  [/verdict (?:allow|annotate|rewrite|hold|deny|kill) · risk/, "the scored detail header"],
  [/\brisk \d\.\d\d\b/, "a risk score"],
  [/\bbudget \d+\/\d+/, "a budget figure"],
  [/[a-z-]+@\d+: (?:annotate|rewrite|hold|deny|kill)\b/, "a policy's verdict line"],
  [/\bscope gap \d/, "a scope feature"],
];

/** Forbidden matches in each body (`<file>: <what>: …<match>…`). */
export function leaksIn(bodies: ReadonlyArray<readonly [string, string]>): string[] {
  return bodies.flatMap(([file, text]) =>
    HUMAN_ONLY.flatMap(([pattern, what]) => {
      const m = pattern.exec(text);
      return m === null ? [] : [`${file}: ${what}: …${m[0]}…`];
    }),
  );
}

/** The command line; resolves with the exit code. */
export function runCheck(argv: readonly string[], out: (line: string) => void): number {
  const [cmd, a, b, c, d] = argv;
  const read = (p: string) => readFileSync(p, "utf8");
  if (cmd === "judge" && a !== undefined && b !== undefined && c !== undefined) {
    const found = findJudged(read(a), b, c).filter((j) => d === undefined || j.verdict === d);
    for (const j of found) out(judgedLine(j));
    return found.length > 0 ? 0 : 1;
  }
  if (cmd === "saw" && a !== undefined && b !== undefined && c !== undefined) {
    const found = sawIn(read(a), b, c);
    for (const l of found) out(l);
    return found.length > 0 ? 0 : 1;
  }
  if (cmd === "seen" && a !== undefined && b !== undefined) {
    const lines = modelSaw(read(a), b);
    for (const l of lines) out(l);
    return lines.length > 0 ? 0 : 1;
  }
  if (cmd === "leaks" && a !== undefined) {
    const files = readdirSync(a).filter((f) => f.endsWith(".json"));
    const found = leaksIn(files.map((f) => [f, read(join(a, f))] as const));
    for (const l of found) out(l);
    if (found.length === 0) out(`no human-only text in ${files.length} request bodies`);
    return found.length === 0 ? 0 : 1;
  }
  if (cmd === "path" && a !== undefined && b !== undefined) {
    const found = requestsTo(read(a), b);
    for (const l of found) out(l);
    return found.length > 0 ? 0 : 1;
  }
  if (cmd === "digest" && a !== undefined) {
    for (const l of digestRequests(read(a))) out(l);
    return 0;
  }
  out(
    "usage: check.ts judge <audit> <tool|*> <substring> [verdict] | saw <requests> <scenario|*> <substring> | seen <requests> <scenario> | leaks <bodies-dir> | path <requests> <prefix> | digest <requests>",
  );
  return 2;
}

/** Requests whose path starts with `prefix` (`<seq> <method> <path> <ua>`). */
export function requestsTo(requestsText: string, prefix: string): string[] {
  return parseLines(requestsText)
    .filter((l) => str(l.path).startsWith(prefix))
    .map(
      (l) => `${str(l.seq)} ${str(l.method)} ${str(l.path)} ${str(obj(l.headers)["user-agent"])}`,
    );
}

/**
 * The request log as committed with a capture: per request, what arrived (path, auth
 * facts, user agent, model, tool names) and what the model read in its last turn, instead
 * of the whole (harness-owned, bulky) body. The full log stays with the run.
 */
export function digestRequests(requestsText: string): string[] {
  return parseLines(requestsText).map((l) => {
    const body = obj(l.body);
    const tools = Array.isArray(body.tools) ? body.tools.length : 0;
    return JSON.stringify({
      seq: l.seq,
      at: l.at,
      method: l.method,
      path: l.path,
      api: l.api,
      auth: l.auth,
      user_agent: obj(l.headers)["user-agent"] ?? null,
      model: body.model ?? null,
      tools,
      reply: l.reply ?? null,
      model_read: lastTurn(l.body),
    });
  });
}

if (import.meta.main) {
  process.exit(runCheck(process.argv.slice(2), (l) => process.stdout.write(`${l}\n`)));
}
