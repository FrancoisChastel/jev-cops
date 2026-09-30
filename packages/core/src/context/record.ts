import { createHash } from "node:crypto";
import { canonicalTool } from "../normalizer/normalize.ts";
import { PATCH_VERB } from "../normalizer/patch.ts";
import type { NormalizedCommand, NormalizedEvent } from "../normalizer/types.ts";
import type { ContextConfig } from "./config.ts";
import { isSecretPath } from "./secrets.ts";
import { contentTaint } from "./taint.ts";
import type { CallRecord, FileWrite, SecretRead, TaintEntry } from "./types.ts";

/**
 * Pure derivations from a normalized event to case-file records. Both case-file
 * backends apply exactly these, so in-memory and SQLite sessions cannot drift.
 */

/** Clamps to [0, 1]; NaN counts as fully tainted. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** The call record a pre event creates (`phase: "pre"`, no result yet). */
export function newCallRecord(n: NormalizedEvent, at: number, taint: number): CallRecord {
  return {
    callId: n.event.call.id,
    sessionId: n.event.session.id,
    at,
    phase: "pre",
    kind: n.kind,
    verbs: [...new Set(n.commands.flatMap((c) => c.verbs))],
    paths: [...n.paths],
    hosts: [...n.hosts],
    argv: n.commands.flatMap((c) => c.argv),
    taint: clamp01(taint),
  };
}

/** The ok flag and exit code of a post event; null for a pre event. */
export function resultOf(n: NormalizedEvent): { ok: boolean; exitCode?: number } | null {
  if (n.event.phase !== "post") return null;
  const { ok, exit_code } = n.event.result;
  return exit_code === undefined ? { ok } : { ok, exitCode: exit_code };
}

/** True when the result is a failure: `ok: false` or a non-zero exit code. */
export function isFailure(result: { ok: boolean; exitCode?: number }): boolean {
  return !result.ok || (result.exitCode !== undefined && result.exitCode !== 0);
}

/** Paths the event reads or executes (every access except write and delete). */
export function readPaths(n: NormalizedEvent): string[] {
  const refs = n.commands.flatMap((c) => c.pathRefs);
  const reads = refs.filter((r) => r.access !== "write" && r.access !== "delete");
  return [...new Set(reads.map((r) => r.path))];
}

/** Secret reads by path glob: every read/exec/unknown access to a secret path. */
export function secretPathReads(n: NormalizedEvent, at: number, cfg: ContextConfig): SecretRead[] {
  return readPaths(n)
    .filter((path) => isSecretPath(path, cfg.home, cfg.secrets.pathGlobs))
    .map((path) => ({ path, callId: n.event.call.id, at, reason: "path-glob" as const }));
}

/** Secret reads by content pattern: the read paths, or `stdout:<callId>` when none. */
export function contentSecretReads(n: NormalizedEvent, at: number): SecretRead[] {
  const paths = readPaths(n);
  const callId = n.event.call.id;
  const targets = paths.length > 0 ? paths : [`stdout:${callId}`];
  return targets.map((path) => ({ path, callId, at, reason: "content-pattern" as const }));
}

const SYMBOLIC_EXEC = /^[ugoa]*[+=][rwxXst]*x/;
const OCTAL = /^[0-7]{3,4}$/;

function makesExecutable(c: NormalizedCommand): boolean {
  if (c.verbs[0] !== "chmod") return false;
  return c.argv.slice(1).some((a) => {
    if (SYMBOLIC_EXEC.test(a)) return true;
    return OCTAL.test(a) && [...a.slice(-3)].some((d) => Number(d) % 2 === 1);
  });
}

/** An edit's replacement text in Pi's `edits`: `new_string` or `newText`. */
function newStringOf(edit: unknown): string {
  if (typeof edit !== "object" || edit === null) return "";
  const key = ["new_string", "newText"].find((k) => Object.hasOwn(edit, k));
  const value: unknown = key === undefined ? undefined : (edit as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function toolContent(n: NormalizedEvent): { text: string; full: boolean } {
  const input = n.event.call.input;
  const str = (key: string): string => {
    const v = Object.hasOwn(input, key) ? input[key] : undefined;
    return typeof v === "string" ? v : "";
  };
  const edits: unknown = Object.hasOwn(input, "edits") ? input.edits : undefined;
  const editText = Array.isArray(edits) ? edits.map(newStringOf).join("\n") : "";
  const replacements = [str("new_string"), str("newString"), str("new_source")];
  const text = [str("content"), ...replacements, editText].join("\n");
  return { text, full: canonicalTool(n.event.call.tool) === "Write" && str("content") !== "" };
}

/**
 * The text a command writes: its arguments and heredoc bodies. A patch command (an
 * `apply_patch` tool's file operation, patch.ts) carries the lines it adds as its body.
 */
function commandContent(c: NormalizedCommand): { text: string; full: boolean } {
  const truncates = c.redirects.some((r) => r.op === ">" || r.op === ">|");
  const full = c.heredocs.length > 0 && truncates;
  return { text: [...c.argv.slice(1), ...c.heredocs].join("\n"), full };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function commandWrites(
  n: NormalizedEvent,
  c: NormalizedCommand,
  at: number,
  base: {
    taint: number;
    entries: ReadonlyArray<TaintEntry>;
    files: ReadonlyMap<string, FileWrite>;
  },
): FileWrite[] {
  const writes = c.pathRefs.filter((r) => r.access === "write");
  if (writes.length === 0) return [];
  const fromCommand = c.verbs[0] === PATCH_VERB || canonicalTool(n.event.call.tool) === "Bash";
  const content = fromCommand ? commandContent(c) : toolContent(n);
  const sourceTaint = c.pathRefs
    .filter((r) => r.access !== "write")
    .reduce((max, r) => Math.max(max, base.files.get(r.path)?.taint ?? 0), 0);
  const taint = Math.max(base.taint, contentTaint(content.text, base.entries), sourceTaint);
  const executable = makesExecutable(c);
  return writes.map((r) => ({
    path: r.path,
    ...(content.full ? { sha256: sha256(content.text) } : {}),
    taint: clamp01(taint),
    callId: n.event.call.id,
    at,
    ...(executable ? { executable } : {}),
  }));
}

/**
 * Files the event writes. A write's taint is the max of the event's own taint, the
 * taint of any tainted string in the written content, and the taint of self-written
 * files the same command reads (`cp`, `cat a > b`, a patch's move source): laundering
 * keeps its taint (T10). The content is the shell command's text, a patch file
 * operation's added lines, or the tool input's `content`, `new_string` (Claude Code),
 * `newString` (OpenCode), `new_source` (NotebookEdit) or `edits` (Pi).
 */
export function fileWrites(
  n: NormalizedEvent,
  at: number,
  taint: number,
  entries: ReadonlyArray<TaintEntry>,
  files: ReadonlyMap<string, FileWrite>,
): FileWrite[] {
  return n.commands.flatMap((c) => commandWrites(n, c, at, { taint, entries, files }));
}

/** Combines two writes to one path: latest time and call, max taint, sticky executable. */
export function mergeFileWrite(prev: FileWrite | undefined, next: FileWrite): FileWrite {
  if (prev === undefined) return next;
  const executable = prev.executable === true || next.executable === true;
  return {
    path: next.path,
    ...(next.sha256 === undefined ? {} : { sha256: next.sha256 }),
    taint: Math.max(prev.taint, next.taint),
    callId: next.callId,
    at: next.at,
    ...(executable ? { executable } : {}),
  };
}

/** Entries of `incoming` that are new or raise an existing value's taint. */
export function taintUpdates(
  existing: ReadonlyMap<string, TaintEntry>,
  incoming: ReadonlyArray<TaintEntry>,
): TaintEntry[] {
  const best = new Map<string, TaintEntry>();
  for (const entry of incoming) {
    const current = best.get(entry.value) ?? existing.get(entry.value);
    if (current === undefined || entry.taint > current.taint) best.set(entry.value, entry);
  }
  return [...best.values()];
}
