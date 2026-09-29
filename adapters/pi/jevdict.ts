/**
 * Jevdict extension for Pi (verified against Pi v0.87.1). Install into
 * `~/.pi/agent/extensions/` or `<project>/.pi/extensions/`; Pi loads it with jiti.
 *
 * Translation only, no policy: every tool call goes to `jevdictd` as a canonical
 * `jevdict.event/1` pre event and the verdict is mapped back onto Pi's `tool_call`
 * contract; every tool result goes back as a post event. Runtime imports are Node
 * built-ins only, so this one file is the whole installed extension. See docs/adapters.md.
 */
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { text as readText } from "node:stream/consumers";
import type {
  JevdictOptions,
  Judged,
  PiApi,
  PiCallKind,
  PiContext,
  PiToolCallEvent,
  PiToolCallResult,
  PiToolResultEvent,
  PiToolResultPatch,
  Reply,
} from "./pi-types.ts";

/** Replaced by `install.ts` with the socket path it was given; null = env or default. */
const INSTALLED_SOCKET: string | null = null;

/** Best-effort tool → kind (the daemon classifies for itself; `other` is scored as exec). */
const kindOf = ({ toolName: t }: { toolName: string }): PiCallKind => {
  if (["read", "grep", "find", "ls"].includes(t)) return "fs.read";
  if (t === "write" || t === "edit") return "fs.write";
  return t === "bash" || t === "powershell" ? "exec" : "other";
};
const VERDICTS: readonly string[] = ["allow", "annotate", "rewrite", "hold", "deny", "kill"];
const TIMEOUT = "judge timeout";
const HEAD_CHARS = 4096;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `evt_` + a canonical ULID: 48-bit ms time, 80 random bits, Crockford base32. */
export function mintEventId(now = Date.now()): string {
  const time = [...now.toString(32).padStart(10, "0")].map((d) => Number.parseInt(d, 32));
  const random = [...randomBytes(16)].map((b) => b % 32);
  return `evt_${[...time, ...random].map((v) => CROCKFORD.charAt(v)).join("")}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** `v[k1][k2]…`, undefined as soon as a step is not an object. */
const pick = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), v);
/** Why a request failed, as the agent-facing reason says it. */
const why = (e: unknown): string =>
  e instanceof Error && e.message === TIMEOUT ? TIMEOUT : `judge unreachable (${String(e)})`;

/** One JSON request over the Unix socket (`node:http`: Pi runs on Node, not Bun). */
function send(socket: string, method: string, path: string, body: unknown, ms: number) {
  return new Promise<Reply>((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    const req = request({ socketPath: socket, method, path, headers }, (res) => {
      const status = res.statusCode ?? 0;
      readText(res)
        .then((t) => resolve({ status, body: t ? JSON.parse(t) : null }))
        .catch(reject);
    });
    const timer = setTimeout(() => {
      reject(new Error(TIMEOUT));
      req.destroy();
    }, ms);
    req.on("error", reject).on("close", () => clearTimeout(timer));
    req.end(body === undefined ? "" : JSON.stringify(body));
  });
}

/** The daemon's verdict for event `id`, or null when the reply is not one (fail closed). */
function parseVerdict(body: unknown, id: string): Judged | null {
  if (!isObject(body) || body.event_id !== id || typeof body.reason !== "string") return null;
  const verdict = body.verdict;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) return null;
  const note = typeof body.context_note === "string" ? body.context_note : null;
  const input = isObject(body.updated_input) ? body.updated_input : null;
  if (verdict === "rewrite" && input === null) return null;
  return { verdict: verdict as Judged["verdict"], reason: body.reason, note, input };
}

/** Local log for the human: a TUI/RPC notification, else stderr (print/json modes). */
const warn = (ctx: PiContext, m: string) =>
  ctx.hasUI ? ctx.ui.notify(m, "warning") : process.stderr.write(`${m}\n`);

/** Registers the jevdict handlers on `pi`, talking to `jevdictd` at `opts.socket`. */
export function register(pi: PiApi, opts: JevdictOptions): void {
  const judgeMs = opts.judgeTimeoutMs ?? 13_000;
  const shortMs = opts.observeTimeoutMs ?? 2_000;
  let session = { task: null as string | null, startedAt: new Date().toISOString() };
  const notes = new Map<string, string>();
  const call = (method: string, path: string, body: unknown, ms: number) =>
    send(opts.socket, method, path, body, ms);
  const blocked = (r: string): PiToolCallResult => ({ block: true, reason: `jevdict: ${r}` });

  const base = (e: PiToolCallEvent | PiToolResultEvent, ctx: PiContext, phase: string) => ({
    schema: "jevdict.event/1",
    id: mintEventId(),
    phase,
    harness: "pi",
    session: {
      id: `sess_${ctx.sessionManager.getSessionId()}`,
      parent_id: null,
      ...(session.task === null ? {} : { task: session.task }),
      mode: ctx.hasUI ? "interactive" : "headless",
      started_at: session.startedAt,
    },
    actor: { kind: "agent", ...(ctx.model?.id === undefined ? {} : { model: ctx.model.id }) },
    call: {
      id: `call_${e.toolCallId}`,
      tool: e.toolName,
      kind: kindOf(e),
      input: e.input,
      cwd: ctx.cwd,
    },
    env: { sandbox: { kind: "none" } },
  });

  /** T2/T3: fail closed unless the call is read-only (observe-only: log and continue). */
  const unavailable = (e: PiToolCallEvent, ctx: PiContext, cause: string) => {
    if (kindOf(e) !== "fs.read") return blocked(`${cause}; blocking (fail closed)`);
    warn(ctx, `jevdict: ${cause}; read-only ${e.toolName} allowed (observe-only, fail open)`);
    return undefined;
  };

  /** Interactive hold: ask with the daemon's normalized raw command and detail (T8). */
  const hold = async (v: Judged, id: string, ctx: PiContext) => {
    if (!ctx.hasUI) return blocked(v.reason); // D-008: headless hold is a deny
    const shown = await call("GET", `/v1/explain/${id}`, undefined, judgeMs).catch(() => null);
    const payload = shown?.status === 200 ? pick(shown.body, "line", "payload") : undefined;
    const raw = pick(payload, "raw");
    if (typeof raw !== "string") return blocked(v.reason);
    const detail = pick(payload, "decision", "detail");
    const message = typeof detail === "string" ? `${raw}\n\n${detail}` : raw;
    const yes = await ctx.ui.confirm(`Jevdict hold: ${v.reason}`, message);
    const decision = { event_id: id, decision: yes ? "allow" : "deny", by: "pi-user" };
    await call("POST", "/v1/resolve", decision, shortMs).catch((err: unknown) =>
      warn(ctx, `jevdict: resolve not recorded: ${why(err)}`),
    );
    return yes ? undefined : blocked(`${v.reason} (declined by the user)`);
  };

  pi.on("session_start", (e) => {
    if (e.reason === "reload") return;
    const task = e.reason === "new" || e.reason === "fork" ? null : session.task;
    session = { task, startedAt: new Date().toISOString() };
  });

  // T11: the task is the session's first prompt; later prompts never replace it.
  pi.on("before_agent_start", (e) => (session = { ...session, task: session.task ?? e.prompt }));

  pi.on("tool_call", async (e, ctx): Promise<PiToolCallResult | undefined> => {
    const pre = base(e, ctx, "pre");
    const reply = await call("POST", "/v1/judge", pre, judgeMs).catch(why);
    if (typeof reply === "string") return unavailable(e, ctx, reply);
    if (reply.status === 504) return unavailable(e, ctx, TIMEOUT);
    const v = reply.status === 200 ? parseVerdict(reply.body, pre.id) : null;
    if (v === null) return unavailable(e, ctx, `bad judge reply (HTTP ${reply.status})`);
    if (v.note !== null) notes.set(e.toolCallId, v.note);
    if (v.verdict === "rewrite" && v.input !== null) {
      // Pi has no `updatedInput`: mutating `event.input` in place is the rewrite contract.
      for (const key of Object.keys(e.input)) if (!Object.hasOwn(v.input, key)) delete e.input[key];
      Object.assign(e.input, v.input);
    }
    if (v.verdict === "hold") return hold(v, pre.id, ctx);
    if (v.verdict === "deny") return blocked(v.reason);
    if (v.verdict !== "kill") return undefined;
    ctx.abort();
    ctx.shutdown();
    return { ...blocked(v.reason), terminate: true };
  });

  pi.on("tool_result", async (e, ctx): Promise<PiToolResultPatch | undefined> => {
    const text = e.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const result = {
      ok: !e.isError,
      stdout_sha256: createHash("sha256").update(text).digest("hex"),
      stdout_head: text.slice(0, HEAD_CHARS),
      bytes_out: Buffer.byteLength(text),
    };
    await call("POST", "/v1/observe", { ...base(e, ctx, "post"), result }, shortMs).catch(
      (err: unknown) => warn(ctx, `jevdict: observe not recorded (${why(err)}); continuing`),
    );
    const note = notes.get(e.toolCallId);
    notes.delete(e.toolCallId);
    if (note === undefined) return undefined;
    return { content: [...e.content, { type: "text", text: `[jevdict] ${note}` }] };
  });
}

/** The socket: the installed path, else `$JEVDICT_SOCKET`, else `~/.jevdict/jevdictd.sock`. */
export function socketPath(env: Readonly<Record<string, string | undefined>> = process.env) {
  return INSTALLED_SOCKET ?? (env.JEVDICT_SOCKET || join(homedir(), ".jevdict", "jevdictd.sock"));
}

/** Pi's extension entry point. */
export default function jevdict(pi: PiApi): void {
  register(pi, { socket: socketPath() });
}
