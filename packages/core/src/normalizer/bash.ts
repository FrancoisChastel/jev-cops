import type { Node } from "web-tree-sitter";
import { parseBash } from "./parser.ts";
import type { OpaqueSpan } from "./types.ts";
import {
  allChildren,
  EMPTY,
  evalWord,
  type Fragment,
  merge,
  named,
  type RawCommand,
  type RawRedirect,
  type WalkContext,
  type Word,
} from "./words.ts";

export type { Fragment, PipePosition, RawCommand, RawRedirect, Word } from "./words.ts";

/** Every simple command in a script, in execution order, plus its opaque spans. */
export type ParsedScript = Fragment;

interface Extras {
  redirects: RawRedirect[];
  heredocs: string[];
  raw: string | null;
}

const NO_EXTRAS: Extras = { redirects: [], heredocs: [], raw: null };

function withBackground(frag: Fragment): Fragment {
  return { ...frag, commands: frag.commands.map((c) => ({ ...c, background: true })) };
}

function walkChildren(node: Node, ctx: WalkContext): Fragment {
  const children = allChildren(node);
  const frags = children.map((child, i) => {
    if (!child.isNamed) return EMPTY;
    const frag = walkNode(child, ctx);
    const next = children[i + 1];
    return next !== undefined && !next.isNamed && next.type === "&" ? withBackground(frag) : frag;
  });
  return merge(...frags);
}

function evalAssignment(
  node: Node,
  ctx: WalkContext,
): { name: string; value: string; frag: Fragment } {
  const [nameNode, valueNode] = named(node);
  if (valueNode === undefined) return { name: nameNode?.text ?? "", value: "", frag: EMPTY };
  const { word, frag } = evalWord(valueNode, ctx);
  return { name: nameNode?.text ?? "", value: word.value, frag };
}

function evalRedirect(node: Node, ctx: WalkContext): { redirect: RawRedirect; frag: Fragment } {
  const fd = named(node).find((c) => c.type === "file_descriptor")?.text ?? "";
  const op = allChildren(node).find((c) => !c.isNamed)?.text ?? "";
  const dest = named(node).find((c) => c.type !== "file_descriptor" && c.type !== "ERROR");
  const evaluated =
    dest === undefined
      ? { word: { value: "", raw: "", literal: false }, frag: EMPTY }
      : evalWord(dest, ctx);
  return { redirect: { op: fd + op, target: evaluated.word }, frag: evaluated.frag };
}

interface CommandParts {
  words: Word[];
  env: Record<string, string>;
  redirects: RawRedirect[];
  heredocs: string[];
  frags: Fragment[];
}

function collectParts(node: Node, ctx: WalkContext): CommandParts {
  const parts: CommandParts = { words: [], env: {}, redirects: [], heredocs: [], frags: [] };
  for (const child of named(node)) {
    if (child.type === "variable_assignment") {
      const a = evalAssignment(child, ctx);
      parts.env = { ...parts.env, [a.name]: a.value };
      parts.frags.push(a.frag);
    } else if (child.type === "file_redirect") {
      const r = evalRedirect(child, ctx);
      parts.redirects.push(r.redirect);
      parts.frags.push(r.frag);
    } else if (child.type === "herestring_redirect") {
      const e = evalWord(named(child)[0] ?? child, ctx);
      parts.heredocs.push(e.word.value);
      parts.frags.push(e.frag);
    } else if (child.type !== "comment") {
      const e = evalWord(child.type === "command_name" ? (named(child)[0] ?? child) : child, ctx);
      parts.words.push(e.word);
      parts.frags.push(e.frag);
    }
  }
  return parts;
}

function walkCommand(node: Node, ctx: WalkContext, extras: Extras): Fragment {
  const parts = collectParts(node, ctx);
  const inner = merge(...parts.frags);
  const name = named(node).find((c) => c.type === "command_name");
  if (parts.words.length === 0 || name?.text === "") return inner;
  const command: RawCommand = {
    words: parts.words,
    env: parts.env,
    redirects: [...parts.redirects, ...extras.redirects],
    heredocs: [...parts.heredocs, ...extras.heredocs],
    raw: extras.raw ?? node.text,
    background: false,
    pipe: null,
  };
  return { commands: [...inner.commands, command], opaque: inner.opaque };
}

function walkDeclaration(node: Node, ctx: WalkContext): Fragment {
  const keyword = allChildren(node).find((c) => !c.isNamed)?.text ?? node.type;
  const evaluated = named(node).map((c) => evalWord(c, ctx));
  const inner = merge(...evaluated.map((e) => e.frag));
  const command: RawCommand = {
    words: [{ value: keyword, raw: keyword, literal: true }, ...evaluated.map((e) => e.word)],
    env: {},
    redirects: [],
    heredocs: [],
    raw: node.text,
    background: false,
    pipe: null,
  };
  return { commands: [...inner.commands, command], opaque: inner.opaque };
}

function nestedPipelineId(stage: Node): number | null {
  if (stage.type === "pipeline") return stage.startIndex;
  const body = stage.type === "redirected_statement" ? stage.childForFieldName("body") : null;
  return body?.type === "pipeline" ? body.startIndex : null;
}

/**
 * Gives every command of each stage its position in one pipeline. A stage that is
 * itself a pipeline (`a | b > f | c` nests that way) is flattened into the outer one;
 * pipelines inside substitutions keep their own positions.
 */
function assignPipe(
  stages: ReadonlyArray<{ frag: Fragment; nested: number | null }>,
  id: number,
): Fragment {
  const widths = stages.map(({ frag, nested }) => {
    const inner = frag.commands.find((c) => nested !== null && c.pipe?.id === nested);
    return inner?.pipe?.size ?? 1;
  });
  const size = widths.reduce((a, b) => a + b, 0);
  let offset = 0;
  const frags = stages.map(({ frag, nested }, i) => {
    const base = offset;
    offset += widths[i] ?? 1;
    const commands = frag.commands.map((c) => {
      const own = c.pipe !== null && c.pipe.id === nested;
      if (c.pipe !== null && !own) return c;
      return { ...c, pipe: { id, index: base + (own && c.pipe ? c.pipe.index : 0), size } };
    });
    return { ...frag, commands };
  });
  return merge(...frags);
}

function walkPipeline(node: Node, ctx: WalkContext): Fragment {
  const stages = named(node)
    .filter((c) => c.type !== "comment")
    .map((stage) => ({ frag: walkNode(stage, ctx), nested: nestedPipelineId(stage) }));
  return assignPipe(stages, node.startIndex);
}

interface Heredoc {
  body: string;
  redirects: RawRedirect[];
  pipeTail: Node | null;
  tail: Node[];
  frag: Fragment;
}

function scanHeredocBody(body: Node, ctx: WalkContext): Fragment {
  return merge(
    ...named(body).map((c) => (c.type === "heredoc_content" ? EMPTY : walkNode(c, ctx))),
  );
}

function evalHeredoc(node: Node, ctx: WalkContext): Heredoc {
  let quoted = false;
  const acc: Heredoc = { body: "", redirects: [], pipeTail: null, tail: [], frag: EMPTY };
  for (const child of named(node)) {
    if (child.type === "heredoc_start") quoted = /['"\\]/.test(child.text);
    else if (child.type === "heredoc_body") {
      acc.body = child.text;
      if (!quoted) acc.frag = merge(acc.frag, scanHeredocBody(child, ctx));
    } else if (child.type === "file_redirect") {
      const r = evalRedirect(child, ctx);
      acc.redirects.push(r.redirect);
      acc.frag = merge(acc.frag, r.frag);
    } else if (child.type === "pipeline") acc.pipeTail = child;
    else if (child.type !== "heredoc_end") acc.tail.push(child);
  }
  return acc;
}

function attach(frag: Fragment, extras: Extras, lastStageOf: number | null): Fragment {
  const commands = frag.commands.map((c) => {
    const inLastStage = c.pipe?.id === lastStageOf && c.pipe?.index === (c.pipe?.size ?? 0) - 1;
    if (lastStageOf !== null && !inLastStage) return c;
    return {
      ...c,
      redirects: [...c.redirects, ...extras.redirects],
      heredocs: [...c.heredocs, ...extras.heredocs],
    };
  });
  return { ...frag, commands };
}

function walkRedirected(node: Node, ctx: WalkContext): Fragment {
  const body = node.childForFieldName("body");
  const redirects: RawRedirect[] = [];
  const heredocs: Heredoc[] = [];
  const herestrings: string[] = [];
  const frags: Fragment[] = [];
  for (const child of named(node).filter((c) => c.id !== body?.id)) {
    if (child.type === "heredoc_redirect") heredocs.push(evalHeredoc(child, ctx));
    else if (child.type === "herestring_redirect") {
      const e = evalWord(named(child)[0] ?? child, ctx);
      herestrings.push(e.word.value);
      frags.push(e.frag);
    } else if (child.type === "file_redirect") {
      const r = evalRedirect(child, ctx);
      redirects.push(r.redirect);
      frags.push(r.frag);
    }
  }
  const extras: Extras = {
    redirects: [...redirects, ...heredocs.flatMap((h) => h.redirects)],
    heredocs: [...heredocs.map((h) => h.body), ...herestrings],
    raw: node.text,
  };
  const head = walkBody(body, ctx, extras);
  return withHeredocTails(merge(...frags, ...heredocs.map((h) => h.frag), head), heredocs, ctx);
}

function walkBody(body: Node | null, ctx: WalkContext, extras: Extras): Fragment {
  if (body === null) return EMPTY;
  if (body.type === "command") return walkCommand(body, ctx, extras);
  return attach(walkNode(body, ctx), extras, body.type === "pipeline" ? body.startIndex : null);
}

function withHeredocTails(
  head: Fragment,
  heredocs: ReadonlyArray<Heredoc>,
  ctx: WalkContext,
): Fragment {
  const pipeTail = heredocs.find((h) => h.pipeTail !== null)?.pipeTail ?? null;
  const piped =
    pipeTail === null
      ? head
      : assignPipe(
          [
            { frag: head, nested: null },
            ...named(pipeTail).map((s) => ({
              frag: walkNode(s, ctx),
              nested: nestedPipelineId(s),
            })),
          ],
          pipeTail.startIndex,
        );
  const tails = heredocs.flatMap((h) => h.tail).map((t) => walkNode(t, ctx));
  return merge(piped, ...tails);
}

function walkNode(node: Node, ctx: WalkContext): Fragment {
  switch (node.type) {
    case "command":
      return walkCommand(node, ctx, NO_EXTRAS);
    case "redirected_statement":
      return walkRedirected(node, ctx);
    case "pipeline":
      return walkPipeline(node, ctx);
    case "declaration_command":
    case "unset_command":
      return walkDeclaration(node, ctx);
    case "variable_assignment":
      return evalAssignment(node, ctx).frag;
    case "comment":
      return EMPTY;
    case "command_substitution":
    case "process_substitution":
    case "simple_expansion":
    case "expansion":
    case "arithmetic_expansion":
    case "string":
    case "concatenation":
      return evalWord(node, ctx).frag;
    default:
      return walkChildren(node, ctx);
  }
}

function nearestText(node: Node): string {
  let current: Node | null = node;
  while (current !== null && current.text === "") current = current.parent;
  return current?.text ?? "";
}

function parseErrors(node: Node): OpaqueSpan[] {
  if (node.isError) return [{ reason: "parse-error", span: node.text }];
  if (node.isMissing) return [{ reason: "parse-error", span: nearestText(node) }];
  if (!node.hasError) return [];
  return allChildren(node).flatMap(parseErrors);
}

function unparseable(source: string): ParsedScript {
  const word: Word = { value: source, raw: source, literal: false };
  const command: RawCommand = {
    words: [word],
    env: {},
    redirects: [],
    heredocs: [],
    raw: source,
    background: false,
    pipe: null,
  };
  return { commands: [command], opaque: [{ reason: "parse-error", span: source }] };
}

function flatten(root: Node, source: string, home: string): ParsedScript {
  const ctx: WalkContext = { home, walk: (node) => walkNode(node, ctx) };
  const frag = walkNode(root, ctx);
  const errors = parseErrors(root);
  if (frag.commands.length === 0 && errors.length > 0) return unparseable(source);
  return { commands: frag.commands, opaque: [...frag.opaque, ...errors] };
}

/**
 * Flattens a bash script into simple commands across pipelines, lists, subshells,
 * compound statements, function bodies and substitutions. Never throws: a tree with
 * `ERROR`/`MISSING` nodes flags those spans `parse-error`, and input that yields no
 * command at all (or cannot be parsed) becomes one non-literal command (D-005).
 */
export async function parseScript(source: string, home: string): Promise<ParsedScript> {
  const parsed = await parseBash(source, (root) => flatten(root, source, home));
  return parsed ?? unparseable(source);
}
