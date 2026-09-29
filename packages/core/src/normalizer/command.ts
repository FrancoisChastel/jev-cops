import type { CallKind } from "../schema/event.ts";
import { type ParsedScript, parseScript, type RawCommand } from "./bash.ts";
import { type Classification, classifyArgv, maxKind } from "./classify.ts";
import { decodeLiteral, isDecoder } from "./decode.ts";
import { absolutize } from "./paths.ts";
import { redirectRefs } from "./redirects.ts";
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

function opaqueOf(ctx: CommandContext, writesFile: boolean): OpaqueSpan[] {
  const span = ctx.raw.raw;
  const reasons: OpaqueReason[] = [
    ...(ctx.c.wrapped ? (["interpreter"] as const) : []),
    ...[interpreterReason(ctx)].filter((r): r is OpaqueReason => r !== null),
    ...(heredocExec(ctx, writesFile) ? (["heredoc-exec"] as const) : []),
  ];
  return reasons.map((reason) => ({ reason, span }));
}

/** Shell code this command runs that is visible as text: `-c`, eval, heredocs, decoded payloads. */
function nestedCode(ctx: CommandContext): string[] {
  const interp = ctx.c.interpreter;
  if (interp === null || !interp.shell) return [];
  if (interp.code !== null) return [interp.code];
  if (!interp.stdin) return [];
  const feeders = earlierStages(ctx);
  const piped = fedByDecoder(ctx)
    ? feeders.flatMap((s) => decodedOf(s.raw).map((d) => d.decoded))
    : feeders.flatMap((s) => s.raw.heredocs);
  return [...ctx.raw.heredocs, ...(readsPipe(ctx) ? piped : [])];
}

function argRefs(raw: RawCommand, c: Classification, cwd: string): PathRef[] {
  return c.paths.flatMap((p) => {
    const word = raw.words[p.index];
    const path = word?.literal === true ? absolutize(p.value, cwd) : null;
    return path === null ? [] : [{ raw: word?.raw ?? p.value, path, access: p.access }];
  });
}

function commandKind(ctx: CommandContext, redirects: ReadonlyArray<PathRef>): CallKind {
  if (ctx.c.interpreter !== null) return "exec";
  const fromRedirects = redirects.reduce<CallKind>(
    (kind, r) => maxKind(kind, r.access === "write" ? "fs.write" : "fs.read"),
    ctx.c.kind,
  );
  return ctx.raw.background ? maxKind(fromRedirects, "spawn") : fromRedirects;
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function buildCommand(ctx: CommandContext, scope: Scope, redirects: PathRef[]): NormalizedCommand {
  const { raw, c } = ctx;
  const pathRefs = [...argRefs(raw, c, scope.cwd), ...redirects];
  return {
    argv: argvOf(raw),
    env: { ...raw.env, ...c.env },
    redirects: raw.redirects.map((r) => ({ op: r.op, target: r.target.value })),
    heredocs: raw.heredocs,
    raw: raw.raw,
    kind: commandKind(ctx, redirects),
    targets: {
      paths: unique(pathRefs.map((r) => r.path)),
      hosts: c.hosts.filter((h) => !/[$`]/.test(h)),
    },
    pathRefs,
    verbs: raw.background ? [...c.verbs, "background"] : c.verbs,
    isInterpreter: c.interpreter !== null,
    viaInterpreter: scope.via,
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
  const nested = await Promise.all(nestedCode(ctx).map((code) => analyse(code, inner)));
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

async function analyse(source: string, scope: Scope): Promise<Analysis> {
  return analyseScript(await parseScript(source, scope.home), scope);
}

function uniqueSpans(spans: ReadonlyArray<OpaqueSpan>): OpaqueSpan[] {
  const seen = new Set<string>();
  return spans.filter((s) => {
    const key = `${s.reason}\u0000${s.span}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Event-level kind: `exec` when anything is opaque or any command is an interpreter,
 * `other` when there are no commands, else the most severe command kind in the order
 * fs.delete > net > fs.write > spawn > exec > fs.read > other. A plain unknown binary
 * ranks below every known side effect so a leading `cd .` cannot hide a delete or a
 * network call.
 */
export function eventKind(
  commands: ReadonlyArray<NormalizedCommand>,
  opaque: ReadonlyArray<OpaqueSpan>,
): CallKind {
  if (opaque.length > 0 || commands.some((c) => c.isInterpreter)) return "exec";
  return commands.reduce<CallKind>((kind, c) => maxKind(kind, c.kind), "other");
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
  const analysis = await analyse(command, { ...opts, depth: 0, via: false });
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
