import {
  type CaseFile,
  parseSessionEvent,
  REPORT_ONLY_CONFIG_SOURCES,
  type SessionEvent,
  sha256Hex,
} from "@jevdict/core";
import type { Runtime } from "./daemon.ts";
import type { Reply } from "./service.ts";

/** The task is capped at 16 KB of UTF-8 (a pasted log must not become a huge task). */
export const MAX_TASK_BYTES = 16_384;

const REPORT_ONLY: ReadonlySet<string> = new Set(REPORT_ONLY_CONFIG_SOURCES);
type Payload = Record<string, unknown>;

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * True when `sessionId` (or its root) is latched killed and enforcement is on. In observe
 * mode nothing is blocked, so a latch never shows (and none is set).
 */
export function sessionKilled(rt: Runtime, sessionId: string, rootId: string): boolean {
  return rt.config.enforcement.mode === "enforce" && rt.latch.find(sessionId, rootId) !== null;
}

function optional(key: string, value: unknown): Payload {
  return value === undefined || value === null ? {} : { [key]: value };
}

/** The fields every `session` audit line carries. */
function reportHead(r: SessionEvent): Payload {
  return {
    report: r.kind,
    harness: r.harness,
    ...optional("harness_version", r.harness_version),
    parent_id: r.session.parent_id,
    ...optional("mode", r.session.mode),
    ...optional("permission_mode", r.permission_mode),
    ...optional("cwd", r.cwd),
  };
}

/**
 * The first non-empty prompt of a live session becomes the task (T11), capped at
 * {@link MAX_TASK_BYTES}; later prompts are ignored by the case file, which logs the
 * attempt. The audit keeps the task once, and only a hash and size of other prompts.
 */
function onPrompt(rt: Runtime, r: SessionEvent & { kind: "prompt" }, cf: CaseFile, root: string) {
  const text = truncateUtf8(r.prompt, MAX_TASK_BYTES);
  const base = {
    prompt_sha256: sha256Hex(r.prompt),
    prompt_bytes: Buffer.byteLength(r.prompt),
    truncated: text !== r.prompt,
  };
  if (sessionKilled(rt, r.session.id, root)) return { ...base, task_set: false, blocked: true };
  const before = cf.task;
  cf.setTaskOnce(text);
  const taskSet = before === null && cf.task !== null;
  return { ...base, task_set: taskSet, ...(taskSet ? { task: cf.task } : {}) };
}

/** A root session's end closes it and ends its precedents; a subagent's end is only logged. */
function onEnd(rt: Runtime, r: SessionEvent & { kind: "end" }, root: string): Payload {
  const reason = optional("reason", r.reason);
  if (r.session.parent_id !== null) return { ...reason, closed: false, precedents_ended: 0 };
  const closed = rt.sessions.closeRoot(root);
  return { ...reason, closed, precedents_ended: rt.precedents.expireSession(root) };
}

/**
 * A settings change whose file lost the intact jevdict hook block (D-077 proposal): an
 * `anomaly` line, and in `enforce` mode the session is latched killed (plan §5 row 7).
 * `policy_settings` cannot be blocked by the harness: reported and audited only.
 */
function onConfigChange(rt: Runtime, r: SessionEvent & { kind: "config-change" }, root: string) {
  const reportOnly = REPORT_ONLY.has(r.source);
  const tampered = !r.intact && !reportOnly;
  const latched = tampered && rt.config.enforcement.mode === "enforce";
  if (latched) rt.latch.latch(r.session.id, root, "config-change", r.id);
  const where = { source: r.source, ...optional("file_path", r.file_path) };
  if (tampered) {
    rt.audit.append({
      kind: "anomaly",
      event_id: r.id,
      session_id: r.session.id,
      payload: { reason: "hook block removed or altered", ...where, latched },
    });
  }
  return { ...where, intact: r.intact, report_only: reportOnly, latched };
}

function effects(rt: Runtime, r: SessionEvent, cf: CaseFile, root: string): Payload {
  switch (r.kind) {
    case "start":
      return { ...optional("model", r.model), ...optional("source", r.source) };
    case "prompt":
      return onPrompt(rt, r, cf, root);
    case "end":
      return onEnd(rt, r, root);
    case "config-change":
      return onConfigChange(rt, r, root);
  }
}

/**
 * `POST /v1/session` (agent surface, D-071 proposal): validates a `jevdict.session/1`
 * report, caches its facts on the root session (harness, version, model, mode,
 * permission mode), applies its kind (task once, close, config-change latch), appends a
 * `session` audit line and answers `{ ok, task, killed }`. `killed` tells the harness hook
 * to block the prompt of a latched session (plan §5 row 13).
 */
export function handleSession(rt: Runtime, body: unknown): Reply {
  const parsed = parseSessionEvent(body);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error.message, issues: parsed.error.issues } };
  }
  const r = parsed.value;
  const cf = rt.sessions.openSession(r.session.id, r.session.parent_id);
  const root = rt.sessions.rootOf(r.session.id);
  rt.facts.record(root, r);
  const applied = effects(rt, r, cf, root);
  const killed = sessionKilled(rt, r.session.id, root);
  rt.audit.append({
    kind: "session",
    event_id: r.id,
    session_id: r.session.id,
    payload: { ...reportHead(r), ...applied, killed },
  });
  return { status: 200, body: { ok: true, task: cf.task, killed } };
}
