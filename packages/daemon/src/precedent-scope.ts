import { type CallKind, sha256Hex } from "@jev-cops/core";

/**
 * The narrowest key the daemon proposes for a precedent (spec §Precedents): tool kind,
 * normalized command prefix, host or path prefix, task hash. Built only from the judged
 * event and the case-file task; nothing in a request can widen it (T7, T8).
 */
export interface PrecedentScope {
  readonly kind: CallKind;
  /** First two argv words of the first command; null for tools with no command. */
  readonly commandPrefix: string | null;
  /** Sorted, distinct hosts joined with `,`; null when the event names none. */
  readonly host: string | null;
  /** Deepest directory (or the path itself) covering every path; null when none. */
  readonly pathPrefix: string | null;
  readonly taskHash: string;
}

/** What a scope is proposed from and matched against: a normalized or policy event. */
export interface ScopeSource {
  readonly kind: CallKind;
  readonly commands: ReadonlyArray<{ readonly argv: readonly string[] }>;
  readonly hosts: readonly string[];
  readonly paths: readonly string[];
}

/** sha256 of the case-file task (empty string when there is none). */
export function taskHash(task: string | null): string {
  return sha256Hex(task ?? "");
}

function commandPrefix(src: ScopeSource): string | null {
  const argv = src.commands[0]?.argv ?? [];
  return argv.length === 0 ? null : argv.slice(0, 2).join(" ");
}

function hostKey(hosts: readonly string[]): string | null {
  const distinct = [...new Set(hosts)].sort();
  return distinct.length === 0 ? null : distinct.join(",");
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/** The deepest path covering every path, by whole segments. */
function commonPath(paths: readonly string[]): string | null {
  const [first, ...rest] = paths.map(segments);
  if (first === undefined) return null;
  let depth = first.length;
  for (const segs of rest) {
    let i = 0;
    while (i < depth && segs[i] === first[i]) i += 1;
    depth = i;
  }
  return `/${first.slice(0, depth).join("/")}`;
}

/** The daemon's proposal for a precedent granted on this event. */
export function proposeScope(src: ScopeSource, task: string | null): PrecedentScope {
  return {
    kind: src.kind,
    commandPrefix: commandPrefix(src),
    host: hostKey(src.hosts),
    pathPrefix: commonPath(src.paths),
    taskHash: taskHash(task),
  };
}

/** A readable, stable key: `kind|prefix|host-or-path|task-hash-prefix`. */
export function scopeKey(s: PrecedentScope): string {
  const target = s.host ?? s.pathPrefix ?? "-";
  return `${s.kind}|${s.commandPrefix ?? "-"}|${target}|${s.taskHash.slice(0, 12)}`;
}

function under(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

function pathsMatch(scope: PrecedentScope, paths: readonly string[]): boolean {
  if (scope.pathPrefix === null) return paths.length === 0;
  const prefix = scope.pathPrefix;
  return paths.length > 0 && paths.every((p) => under(p, prefix));
}

/**
 * How specific a match `scope` is for `src` under task hash `task`: -1 when it does not
 * match; otherwise larger for narrower scopes (a host beats a path, a deeper path beats a
 * shallower one). Kind, command prefix and task must be equal; hosts equal as a set.
 */
export function matchScore(scope: PrecedentScope, src: ScopeSource, task: string): number {
  const same =
    scope.kind === src.kind &&
    scope.commandPrefix === commandPrefix(src) &&
    scope.taskHash === task &&
    scope.host === hostKey(src.hosts) &&
    pathsMatch(scope, src.paths);
  if (!same) return -1;
  const depth = scope.pathPrefix === null ? 0 : segments(scope.pathPrefix).length;
  return (scope.host === null ? 0 : 1_000) + depth;
}
