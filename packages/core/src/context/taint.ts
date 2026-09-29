import { posix } from "node:path";
import {
  FILE_RULES,
  INTERPRETER_INLINE_FLAGS,
  SHELLS,
  SUBCOMMAND_KINDS,
  VERB_KINDS,
  WRAPPERS,
} from "../normalizer/classify.ts";
import type { NormalizedCommand, NormalizedEvent } from "../normalizer/types.ts";
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG, type TaintConfig } from "./config.ts";
import type { CaseFile, FileWrite, TaintEntry } from "./types.ts";

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`]+/gi;
const HOST_RE = /\b[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PATH_RE = /(?<![\w:/.~-])(?:\/|\.\.?\/|~\/)[^\s"'<>|;&()`,]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;
const COMMAND_SEPARATORS = ["|", "&&", ";"];

/** First words that make an output line command-like: every verb the normalizer knows. */
export const KNOWN_VERBS: ReadonlySet<string> = new Set([
  ...Object.keys(VERB_KINDS),
  ...Object.keys(SUBCOMMAND_KINDS),
  ...Object.keys(WRAPPERS),
  ...Object.keys(FILE_RULES),
  ...Object.keys(INTERPRETER_INLINE_FLAGS),
  ...SHELLS,
  ...["eval", "source", "rsync", "su", "make", "chmod", "base64", "xxd"],
]);

function matches(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[0].replace(TRAILING_PUNCT, ""));
}

function isCommandLike(line: string): boolean {
  const first = line.split(/\s+/)[0] ?? "";
  return KNOWN_VERBS.has(posix.basename(first)) || COMMAND_SEPARATORS.some((s) => line.includes(s));
}

function commandLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(isCommandLike);
}

/**
 * Strings in a post event's `stdout_head` that could steer a later call: URLs, hosts
 * (lower-case), IPs, absolute / `./` / `~` paths and command-like lines. Each is at
 * least `minLength` long, deduped in that priority order, capped per event.
 */
export function extractTaintCandidates(
  post: NormalizedEvent,
  cfg: TaintConfig = DEFAULT_CONTEXT_CONFIG.taint,
): string[] {
  const text = post.event.phase === "post" ? (post.event.result.stdout_head ?? "") : "";
  if (text === "") return [];
  const found = [
    ...matches(text, URL_RE),
    ...matches(text, HOST_RE).map((h) => h.toLowerCase().replace(/\.$/, "")),
    ...matches(text, IP_RE),
    ...matches(text, PATH_RE),
    ...commandLines(text),
  ];
  const unique = [...new Set(found.filter((c) => c.length >= cfg.minLength))];
  return unique.slice(0, cfg.maxCandidatesPerEvent);
}

/** Max taint of the entries `text` contains (case-insensitive); 0 when none. */
export function contentTaint(text: string, entries: ReadonlyArray<TaintEntry>): number {
  const haystack = text.toLowerCase();
  return entries.reduce(
    (max, e) => (e.taint > max && haystack.includes(e.value.toLowerCase()) ? e.taint : max),
    0,
  );
}

/** One argument of a pre event: a word plus the path it resolves to, scored together. */
export interface TaintUnit {
  strings: string[];
  path?: string;
}

function stripQuotes(word: string): string {
  const q = word[0];
  return (q === "'" || q === '"') && word.length > 1 && word.endsWith(q) ? word.slice(1, -1) : word;
}

function argumentWords(argv: ReadonlyArray<string>): string[] {
  return argv.slice(1).flatMap((word) => {
    if (!word.startsWith("-")) return [word];
    const eq = word.indexOf("=");
    return eq < 0 ? [] : [word.slice(eq + 1)];
  });
}

function commandUnits(c: NormalizedCommand): TaintUnit[] {
  const refs = c.pathRefs.map((r) => ({ ...r, raw: stripQuotes(r.raw) }));
  const used = new Set<number>();
  const units = argumentWords(c.argv).map((word): TaintUnit => {
    const at = refs.findIndex((r, i) => !used.has(i) && (r.raw === word || r.path === word));
    const ref = refs[at];
    if (ref === undefined) return { strings: [word] };
    used.add(at);
    return { strings: [...new Set([word, ref.raw, ref.path])], path: ref.path };
  });
  const loose = refs
    .filter((_, i) => !used.has(i))
    .map((r) => ({ strings: r.raw === r.path ? [r.raw] : [r.raw, r.path], path: r.path }));
  const all = [...units, ...loose];
  const text = all.flatMap((u) => u.strings.map((s) => s.toLowerCase()));
  const hosts = c.targets.hosts.filter((h) => !text.some((s) => s.includes(h)));
  return [...all, ...hosts.map((h) => ({ strings: [h] }))].filter((u) => u.strings[0] !== "");
}

/**
 * Argument tokens of a pre event, as scoring units: argv minus command names and bare
 * flags (an `--opt=value` keeps its value), each path word joined with its resolved
 * path, plus hosts not already inside a word. Deduped by first string.
 */
export function taintUnits(n: NormalizedEvent): TaintUnit[] {
  const seen = new Set<string>();
  return n.commands.flatMap(commandUnits).filter((u) => {
    const key = u.strings[0] ?? "";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Taint of a pre event: a fraction in [0, 1] and the tainted strings that matched. */
export interface TaintScore {
  value: number;
  matched: string[];
}

const NO_TAINT: TaintScore = Object.freeze({ value: 0, matched: [] }) as TaintScore;
const WRAPPING = /^["'`(<[]+|["'`)>\].,;:!?]+$/g;

function withAncestors(path: string): string[] {
  const out: string[] = [];
  for (let p = posix.normalize(path); ; p = posix.dirname(p)) {
    out.push(p);
    if (p === "/" || p === ".") return out;
  }
}

function trimSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/** cwd, repo and home plus their parents: the daemon knows them, so they carry no provenance. */
function trustedRoots(n: NormalizedEvent, home: string): Set<string> {
  const bases = [n.event.call.cwd, n.event.env?.git?.repo, home];
  const absolute = bases.filter((b): b is string => b?.startsWith("/") === true);
  return new Set(absolute.flatMap(withAncestors));
}

/** Words the user typed in the task, lower-cased, with `~/x` and `a/b` also resolved. */
function taskTokens(task: string | null, cwd: string, home: string): Set<string> {
  if (task === null) return new Set();
  const words = task
    .split(/\s+/)
    .map((w) => w.replace(WRAPPING, ""))
    .filter((w) => w !== "");
  const resolved = words.flatMap((w) => {
    if (w.startsWith("~/")) return [posix.join(home, w.slice(2))];
    if (w.includes("/") && !w.startsWith("/") && !w.includes("://")) return [posix.join(cwd, w)];
    return [];
  });
  return new Set([...words, ...resolved].map((w) => w.toLowerCase()));
}

interface Scored {
  weight: number;
  matched: string[];
}

function scoreUnit(
  unit: TaintUnit,
  entries: ReadonlyArray<TaintEntry & { lower: string }>,
  files: ReadonlyMap<string, FileWrite>,
  typed: ReadonlySet<string>,
): Scored {
  const lower = unit.strings.map((s) => s.toLowerCase());
  if (lower.some((s) => typed.has(s))) return { weight: 0, matched: [] };
  const hits = entries.filter((e) => lower.some((s) => s.includes(e.lower)));
  const fileTaint = unit.path === undefined ? 0 : (files.get(unit.path)?.taint ?? 0);
  const weight = hits.reduce((m, e) => Math.max(m, e.taint), fileTaint);
  const fileMatch = fileTaint > 0 && unit.path !== undefined ? [unit.path] : [];
  return { weight, matched: [...hits.map((e) => e.value), ...fileMatch] };
}

/**
 * Fraction of a pre event's argument units that equal or contain a tainted string (or
 * name a file the agent wrote from tainted input), weighted by taint level. User-typed
 * text is never tainted: a unit whose word appears in the case file's task scores 0, and
 * a `user` actor scores 0 outright. Entries equal to cwd, repo, home or their parents
 * are ignored. Pure: reads the case file, never writes it.
 */
export function taintFraction(
  pre: NormalizedEvent,
  cf: CaseFile,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): TaintScore {
  if (pre.event.actor?.kind === "user") return NO_TAINT;
  const units = taintUnits(pre);
  if (units.length === 0) return NO_TAINT;
  const roots = trustedRoots(pre, cfg.home);
  const entries = cf
    .taintSet()
    .filter((e) => !roots.has(trimSlash(e.value)))
    .map((e) => ({ ...e, lower: e.value.toLowerCase() }));
  const typed = taskTokens(cf.task, pre.event.call.cwd, cfg.home);
  const files = cf.filesWritten();
  const scored = units.map((u) => scoreUnit(u, entries, files, typed));
  const total = scored.reduce((sum, s) => sum + s.weight, 0);
  const matched = [...new Set(scored.flatMap((s) => s.matched))];
  return { value: Math.min(1, total / units.length), matched };
}
