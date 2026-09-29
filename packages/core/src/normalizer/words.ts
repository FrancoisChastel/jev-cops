import type { Node } from "web-tree-sitter";
import type { OpaqueReason, OpaqueSpan } from "./types.ts";

/**
 * One shell word after quote removal. `literal` is false when any part is only known
 * at run time (`$VAR`, `$(…)`, `$((…))`); such parts stay verbatim in `value`.
 */
export interface Word {
  value: string;
  raw: string;
  literal: boolean;
}

/** A redirect before classification: `op` is fd + operator, e.g. `2>&`, `>>`. */
export interface RawRedirect {
  op: string;
  target: Word;
}

/** Where a command sits in a pipeline; `id` is unique per pipeline within one source. */
export interface PipePosition {
  id: number;
  index: number;
  size: number;
}

/** A simple command as the AST states it, before any classification. */
export interface RawCommand {
  words: Word[];
  env: Record<string, string>;
  redirects: RawRedirect[];
  heredocs: string[];
  raw: string;
  background: boolean;
  pipe: PipePosition | null;
}

/** Commands and opaque spans found under one AST node, in execution order. */
export interface Fragment {
  commands: RawCommand[];
  opaque: OpaqueSpan[];
}

/** What word evaluation needs: the configured home and a way to walk nested statements. */
export interface WalkContext {
  home: string;
  walk: (node: Node) => Fragment;
}

/** A word plus whatever its nested constructs contributed. */
export interface Evaluated {
  word: Word;
  frag: Fragment;
}

/** The fragment with nothing in it. */
export const EMPTY: Fragment = { commands: [], opaque: [] };

/** Concatenates fragments in order. */
export function merge(...frags: ReadonlyArray<Fragment>): Fragment {
  return {
    commands: frags.flatMap((f) => f.commands),
    opaque: frags.flatMap((f) => f.opaque),
  };
}

/** The non-null named children of `node`. */
export function named(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

/** The non-null children of `node`, anonymous tokens included. */
export function allChildren(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null);
}

function literal(value: string, raw: string): Evaluated {
  return { word: { value, raw, literal: true }, frag: EMPTY };
}

function dynamic(raw: string, frag: Fragment): Evaluated {
  return { word: { value: raw, raw, literal: false }, frag };
}

function unescapeWord(text: string): string {
  return text.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
}

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1");
}

const ANSI_C_SIMPLE: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

function decodeAnsiC(body: string): string {
  const pattern = /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|.)/gs;
  return body.replace(pattern, (whole, esc: string) => {
    const head = esc[0] ?? "";
    if (head === "x" || head === "u" || head === "U") {
      return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    }
    if (/^[0-7]/.test(esc)) return String.fromCodePoint(Number.parseInt(esc, 8));
    return ANSI_C_SIMPLE[esc] ?? whole;
  });
}

function unquotedWord(text: string, home: string, atStart: boolean): string {
  if (atStart && /^~(?=\/|$)/.test(text)) return home + unescapeWord(text.slice(1));
  return unescapeWord(text);
}

function combine(parts: ReadonlyArray<Evaluated>, raw: string): Evaluated {
  return {
    word: {
      value: parts.map((p) => p.word.value).join(""),
      raw,
      literal: parts.every((p) => p.word.literal),
    },
    frag: merge(...parts.map((p) => p.frag)),
  };
}

function evalString(node: Node, ctx: WalkContext, prefix: number): Evaluated {
  const text = node.text;
  const parts: Evaluated[] = [];
  let cursor = prefix;
  for (const child of named(node)) {
    const start = child.startIndex - node.startIndex;
    if (start > cursor) parts.push(literal(unescapeDoubleQuoted(text.slice(cursor, start)), ""));
    parts.push(
      child.type === "string_content"
        ? literal(unescapeDoubleQuoted(child.text), child.text)
        : evalWord(child, ctx, false),
    );
    cursor = child.endIndex - node.startIndex;
  }
  const end = text.length - 1;
  if (end > cursor) parts.push(literal(unescapeDoubleQuoted(text.slice(cursor, end)), ""));
  return combine(parts, text);
}

function isHome(node: Node): boolean {
  if (node.type === "simple_expansion") return node.text === "$HOME";
  return node.text === "${HOME}";
}

function evalExpansion(node: Node, ctx: WalkContext): Evaluated {
  if (isHome(node)) return literal(ctx.home, node.text);
  const inner = named(node)
    .filter((c) => c.type !== "variable_name")
    .map((c) => ctx.walk(c));
  const flag: OpaqueSpan = { reason: "dynamic-expansion", span: node.text };
  return dynamic(node.text, merge({ commands: [], opaque: [flag] }, ...inner));
}

function substitution(node: Node, ctx: WalkContext, reason: OpaqueReason): Evaluated {
  const inner = merge(...named(node).map((c) => ctx.walk(c)));
  return dynamic(node.text, {
    commands: inner.commands,
    opaque: [{ reason, span: node.text }, ...inner.opaque],
  });
}

function evalFallback(node: Node, ctx: WalkContext): Evaluated {
  const frag = merge(...named(node).map((c) => ctx.walk(c)));
  const isLiteral = frag.opaque.length === 0;
  return { word: { value: node.text, raw: node.text, literal: isLiteral }, frag };
}

/**
 * Evaluates one word-like node: quotes removed, escapes processed, `~`/`$HOME` expanded
 * with the configured home. Every other expansion stays verbatim, makes the word
 * non-literal and is flagged opaque; substitutions contribute their inner commands.
 */
export function evalWord(node: Node, ctx: WalkContext, atStart = true): Evaluated {
  const text = node.text;
  switch (node.type) {
    case "word":
      return literal(unquotedWord(text, ctx.home, atStart), text);
    case "number":
      return literal(text, text);
    case "raw_string":
      return literal(text.slice(1, -1), text);
    case "ansi_c_string":
      return literal(decodeAnsiC(text.slice(2, -1)), text);
    case "string":
      return evalString(node, ctx, 1);
    case "translated_string":
      return evalString(node, ctx, 2);
    case "concatenation":
      return combine(
        named(node).map((c, i) => evalWord(c, ctx, atStart && i === 0)),
        text,
      );
    case "simple_expansion":
    case "expansion":
      return evalExpansion(node, ctx);
    case "command_substitution":
      return substitution(node, ctx, "command-substitution");
    case "process_substitution":
      return substitution(node, ctx, "process-substitution");
    case "arithmetic_expansion":
      return dynamic(text, { commands: [], opaque: [{ reason: "dynamic-expansion", span: text }] });
    default:
      return evalFallback(node, ctx);
  }
}
