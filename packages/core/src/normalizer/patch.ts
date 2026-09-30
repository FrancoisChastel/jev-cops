import { posix } from "node:path";
import { type Classification, maxKind, plain } from "./classification.ts";
import { resolvePath } from "./paths.ts";
import type { NormalizedCommand, OpaqueSpan, PathRef } from "./types.ts";
import { workDir } from "./writers.ts";

/**
 * The `apply_patch` format shared by Codex (`tool_input.command`) and OpenCode
 * (`patchText`). Grammar from `codex-rs/apply-patch/src/parser.rs:4-22`:
 *
 * ```text
 * start: "*** Begin Patch" LF ("*** Environment ID: " id LF)? hunk* "*** End Patch" LF?
 * hunk:  "*** Add File: " path LF ("+" line LF)*
 *      | "*** Delete File: " path LF
 *      | "*** Update File: " path LF ("*** Move to: " path LF)? change*
 * change: ("@@" | "@@ " ctx | " " line | "-" line | "+" line) LF | "*** End of File" LF
 * ```
 *
 * Codex parses leniently: whitespace around markers is ignored and a patch wrapped in
 * `<<'EOF'` … `EOF` is unwrapped (`parser.rs:228-250`). Paths are joined to the working
 * directory (`Hunk::resolve_path`; OpenCode: `path.resolve(instance.directory, …)`).
 */

/** Names Codex's `apply_patch` answers to when a shell runs it (`exec_command.rs:377`). */
export const APPLY_PATCH_COMMANDS = ["apply_patch", "applypatch"] as const;

/** First verb of every command a patch produces. */
export const PATCH_VERB = "apply_patch";

/** What one file operation does: `move` is an Update with `*** Move to:`. */
export type PatchOp = "add" | "update" | "delete" | "move";

/** One file operation: `path` as written (trimmed), the move target, the added lines. */
export interface PatchHunk {
  op: PatchOp;
  path: string;
  to?: string;
  /** Lines the hunk adds, without their `+`, each ending in `\n` (content taint, T10). */
  added: string;
  /** The hunk's own lines, marker included. */
  raw: string;
}

/**
 * A parsed patch. `valid` is false when the text breaks the grammar; `hunks` then still
 * holds every file marker found anywhere in it, so a malformed patch hides no path.
 */
export interface ParsedPatch {
  valid: boolean;
  hunks: PatchHunk[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const END_OF_FILE = "*** End of File";
const HEREDOC_OPEN = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);

type MarkerOp = "add" | "delete" | "update" | "move" | "env";

const MARKERS: ReadonlyArray<readonly [string, MarkerOp]> = [
  ["*** Add File:", "add"],
  ["*** Delete File:", "delete"],
  ["*** Update File:", "update"],
  ["*** Move to:", "move"],
  ["*** Environment ID:", "env"],
];

type Token =
  | { t: "marker"; op: MarkerOp; path: string; line: string }
  | { t: "eof" | "bad"; line: string }
  | { t: "line"; line: string };

/** `update` until a change line, `moved` after `*** Move to:`, `changed` after changes. */
type State = "header" | "add" | "delete" | "update" | "moved" | "changed";

interface Fold {
  hunks: PatchHunk[];
  valid: boolean;
  state: State;
}

function patchLines(text: string): string[] {
  const lines = text.trim().split(/\r?\n/);
  const wrapped =
    lines.length >= 4 &&
    HEREDOC_OPEN.has(lines[0]?.trim() ?? "") &&
    (lines.at(-1) ?? "").trim().endsWith("EOF");
  return wrapped ? lines.slice(1, -1) : lines;
}

function tokenize(line: string): Token {
  const text = line.trim();
  if (!text.startsWith("***")) return { t: "line", line };
  if (text === END_OF_FILE) return { t: "eof", line };
  const marker = MARKERS.find(([prefix]) => text.startsWith(prefix));
  const path = marker === undefined ? "" : text.slice(marker[0].length).trim();
  if (marker === undefined || path === "") return { t: "bad", line };
  return { t: "marker", op: marker[1], path, line };
}

function withLast(fold: Fold, change: (h: PatchHunk) => PatchHunk, state: State): Fold {
  const last = fold.hunks.at(-1);
  if (last === undefined) return fold;
  return { ...fold, hunks: [...fold.hunks.slice(0, -1), change(last)], state };
}

function appendLine(h: PatchHunk, line: string, added: boolean): PatchHunk {
  const body = added ? `${h.added}${line.slice(1)}\n` : h.added;
  return { ...h, added: body, raw: `${h.raw}\n${line}` };
}

function onMove(fold: Fold, path: string, line: string): Fold {
  const last = fold.hunks.at(-1);
  const updating = fold.state === "update" || fold.state === "changed";
  if (last === undefined || !updating) {
    const stray: PatchHunk = { op: "update", path, added: "", raw: line };
    return { hunks: [...fold.hunks, stray], valid: false, state: "changed" };
  }
  const moved = withLast(
    fold,
    (h) => ({ ...h, op: "move", to: path, raw: `${h.raw}\n${line}` }),
    "moved",
  );
  return fold.state === "update" ? moved : { ...moved, valid: false };
}

function onMarker(fold: Fold, token: Extract<Token, { t: "marker" }>): Fold {
  if (token.op === "move") return onMove(fold, token.path, token.line);
  if (token.op === "env") {
    const first = fold.state === "header" && fold.hunks.length === 0;
    return first ? fold : { ...fold, valid: false };
  }
  const hunk: PatchHunk = { op: token.op, path: token.path, added: "", raw: token.line };
  return { ...fold, hunks: [...fold.hunks, hunk], state: token.op };
}

const CHANGE_PREFIXES = [" ", "-", "+"];

function onLine(fold: Fold, line: string): Fold {
  const blank = line.trim() === "";
  switch (fold.state) {
    case "add":
      return line.startsWith("+")
        ? withLast(fold, (h) => appendLine(h, line, true), "add")
        : { ...fold, valid: false };
    case "update":
    case "moved":
    case "changed": {
      const change =
        blank || line.trim().startsWith("@@") || CHANGE_PREFIXES.includes(line[0] ?? "");
      const next = withLast(fold, (h) => appendLine(h, line, line.startsWith("+")), "changed");
      return change ? next : { ...next, valid: false };
    }
    default:
      return blank ? fold : { ...fold, valid: false };
  }
}

function step(fold: Fold, token: Token): Fold {
  switch (token.t) {
    case "marker":
      return onMarker(fold, token);
    case "eof": {
      const inUpdate = ["update", "moved", "changed"].includes(fold.state);
      return inUpdate ? fold : { ...fold, valid: false };
    }
    case "bad":
      return { ...fold, valid: false };
    default:
      return onLine(fold, token.line);
  }
}

/**
 * Parses patch text into its file operations. Never throws. Stricter than Codex only in
 * ways that fail toward suspicion: whatever it cannot place makes the patch invalid
 * (read as an opaque `parse-error` exec), and every file marker still counts.
 */
export function parsePatch(text: string): ParsedPatch {
  const lines = patchLines(text);
  const enveloped =
    lines.length >= 2 && lines[0]?.trim() === BEGIN && (lines.at(-1) ?? "").trim() === END;
  const body = enveloped ? lines.slice(1, -1) : lines;
  const start: Fold = { hunks: [], valid: enveloped, state: "header" };
  const fold = body.map(tokenize).reduce(step, start);
  return { valid: fold.valid, hunks: fold.hunks };
}

function ref(raw: string, access: PathRef["access"], cwd: string, home: string): PathRef[] {
  const path = resolvePath(raw, cwd, home);
  return path === null ? [] : [{ raw, path, access }];
}

/**
 * The paths a hunk touches, resolved against `cwd` (`~` is `home`, erring toward the
 * protected path): Add and Update write, Delete deletes, a move deletes its source and
 * writes its target.
 */
export function hunkRefs(h: PatchHunk, cwd: string, home: string): PathRef[] {
  switch (h.op) {
    case "delete":
      return ref(h.path, "delete", cwd, home);
    case "move":
      return [...ref(h.path, "delete", cwd, home), ...ref(h.to ?? "", "write", cwd, home)];
    default:
      return ref(h.path, "write", cwd, home);
  }
}

/** Where a patch tool's paths resolve and what its commands are named after. */
export interface PatchContext {
  tool: string;
  cwd: string;
  home: string;
}

/**
 * One command per file operation: argv `[tool, path, target?]`, verbs `[apply_patch, op]`,
 * kind `fs.delete` for a Delete and `fs.write` otherwise (a move is `mv`-like), and the
 * added lines as the command's body (`heredocs`), so they are hashed and can feed content
 * taint like a `Write`'s content.
 */
export function hunkCommands(
  hunks: ReadonlyArray<PatchHunk>,
  ctx: PatchContext,
): NormalizedCommand[] {
  return hunks.map((h) => {
    const pathRefs = hunkRefs(h, ctx.cwd, ctx.home);
    return {
      argv: [ctx.tool, h.path, ...(h.to === undefined ? [] : [h.to])],
      env: {},
      redirects: [],
      heredocs: h.added === "" ? [] : [h.added],
      raw: h.raw,
      kind: h.op === "delete" ? "fs.delete" : "fs.write",
      targets: { paths: [...new Set(pathRefs.map((r) => r.path))], hosts: [] },
      pathRefs,
      verbs: [PATCH_VERB, h.op],
      isInterpreter: false,
      viaInterpreter: false,
    };
  });
}

/**
 * `apply_patch …` run from a shell (Codex intercepts it, `exec_command.rs:377-388`, and
 * puts it on `PATH`): a write whose files are unknown until the patch is read, so it names
 * `unknown` access to the working directory, like `patch` (D-097). {@link readShellPatch}
 * later reads the patch from the argument or the heredoc.
 */
export function classifyApplyPatch(base: number): Classification {
  return plain("fs.write", [PATCH_VERB], { paths: [workDir(base, "unknown")] });
}

function isApplyPatch(word: string): boolean {
  return (APPLY_PATCH_COMMANDS as ReadonlyArray<string>).includes(posix.basename(word));
}

/** The implicit working-directory ref {@link classifyApplyPatch} named. */
function isWorkDirRef(r: PathRef): boolean {
  return r.raw === "" && r.access === "unknown";
}

/** A shell `apply_patch`'s patch: the argument after it, else its last heredoc (stdin). */
function shellPatchText(c: NormalizedCommand): string | undefined {
  const at = c.argv.findIndex(isApplyPatch);
  return at < 0 ? undefined : (c.argv[at + 1] ?? c.heredocs.at(-1));
}

/**
 * Reads the patch of a shell `apply_patch` command: its files join the command's path
 * refs (resolved against the directory the command runs in) and replace the `unknown`
 * working directory; an unreadable patch keeps that ref and adds a `parse-error` span.
 * A patch fed from a pipe or a file is left as `unknown` (not opaque, like `patch`).
 */
export function readShellPatch(
  c: NormalizedCommand,
  home: string,
): { command: NormalizedCommand; opaque: OpaqueSpan[] } {
  const text = c.verbs.includes(PATCH_VERB) ? shellPatchText(c) : undefined;
  const dir = c.pathRefs.find(isWorkDirRef);
  if (text === undefined || dir === undefined) return { command: c, opaque: [] };
  const parsed = parsePatch(text);
  const refs = parsed.hunks.flatMap((h) => hunkRefs(h, dir.path, home));
  const pathRefs = [...c.pathRefs.filter((r) => !parsed.valid || r !== dir), ...refs];
  const deletes = parsed.hunks.some((h) => h.op === "delete");
  const command: NormalizedCommand = {
    ...c,
    kind: deletes ? maxKind(c.kind, "fs.delete") : c.kind,
    pathRefs,
    targets: { ...c.targets, paths: [...new Set(pathRefs.map((r) => r.path))] },
    verbs: [...c.verbs, ...new Set(parsed.hunks.map((h) => h.op))],
  };
  const span: OpaqueSpan =
    c.remote === true
      ? { reason: "parse-error", span: c.raw, remote: true }
      : { reason: "parse-error", span: c.raw };
  return { command, opaque: parsed.valid ? [] : [span] };
}
