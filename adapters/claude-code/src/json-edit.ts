/**
 * Minimal edits to a JSON text (D-089 "indentation kept"; the Docker e2e's F3: install then
 * uninstall turned `"allow": ["Bash(ls:*)"]` multi-line). {@link patchJsonText} rewrites only
 * the parts of the document whose value changes and leaves every other byte as the user
 * wrote it: members and elements that stay are untouched, a removed one takes its separator
 * with it, and an added one is appended in the style of its container (its separator, its
 * key/value spacing, the line indentation and line ending of the file). What it writes is
 * checked: the result must parse to exactly the target, key order included, or the caller
 * falls back to a full serialization.
 *
 * Appending then removing the same members is byte-exact, which is what makes an install
 * followed by an uninstall give the user's file back as it was.
 */

/** A value in the text: its kind and the `[start, end)` of its text. */
type Node = ObjectNode | ArrayNode | ScalarNode;

interface Span {
  readonly start: number;
  readonly end: number;
}

interface ScalarNode extends Span {
  readonly kind: "scalar";
}

interface ObjectNode extends Span {
  readonly kind: "object";
  readonly members: readonly Member[];
}

interface ArrayNode extends Span {
  readonly kind: "array";
  readonly items: readonly Node[];
}

/** An object member: its decoded key, where its key starts, and its value. */
interface Member {
  readonly key: string;
  readonly start: number;
  readonly keyEnd: number;
  readonly value: Node;
}

/** One replacement of the original text. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A value, or an edit set, that cannot be produced by a minimal edit. */
class Unpatchable extends Error {}

const WS = new Set([" ", "\t", "\n", "\r"]);
const DELIMITERS = new Set([",", "]", "}", " ", "\t", "\n", "\r"]);

/** A strict-enough JSON reader that keeps every value's position (the text already parsed). */
class Reader {
  private at = 0;
  constructor(private readonly text: string) {}

  root(): Node {
    this.skip();
    const node = this.value();
    this.skip();
    if (this.at !== this.text.length) throw new Unpatchable("trailing text");
    return node;
  }

  private skip(): void {
    while (this.at < this.text.length && WS.has(this.text[this.at] ?? "")) this.at += 1;
  }

  private value(): Node {
    const c = this.text[this.at];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    const start = this.at;
    if (c === '"') this.string();
    else
      while (this.at < this.text.length && !DELIMITERS.has(this.text[this.at] ?? "")) this.at += 1;
    if (this.at === start) throw new Unpatchable(`no value at ${start}`);
    return { kind: "scalar", start, end: this.at };
  }

  private string(): void {
    this.at += 1;
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      this.at += this.text[this.at] === "\\" ? 2 : 1;
    }
    if (this.text[this.at] !== '"') throw new Unpatchable("unterminated string");
    this.at += 1;
  }

  private expect(c: string): void {
    if (this.text[this.at] !== c) throw new Unpatchable(`expected ${c} at ${this.at}`);
    this.at += 1;
  }

  private object(): ObjectNode {
    const start = this.at;
    this.at += 1;
    const members: Member[] = [];
    this.skip();
    while (this.text[this.at] !== "}") {
      if (members.length > 0) {
        this.expect(",");
        this.skip();
      }
      const keyStart = this.at;
      this.string();
      const key = JSON.parse(this.text.slice(keyStart, this.at)) as string;
      const keyEnd = this.at;
      this.skip();
      this.expect(":");
      this.skip();
      members.push({ key, start: keyStart, keyEnd, value: this.value() });
      this.skip();
    }
    this.at += 1;
    if (new Set(members.map((m) => m.key)).size !== members.length) {
      throw new Unpatchable("duplicate key"); // JSON.parse keeps the last one: leave it to a rewrite
    }
    return { kind: "object", start, end: this.at, members };
  }

  private array(): ArrayNode {
    const start = this.at;
    this.at += 1;
    const items: Node[] = [];
    this.skip();
    while (this.text[this.at] !== "]") {
      if (items.length > 0) {
        this.expect(",");
        this.skip();
      }
      items.push(this.value());
      this.skip();
    }
    this.at += 1;
    return { kind: "array", start, end: this.at, items };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One container's entries, uniformly: where each starts and ends, and its value node. */
interface Entry {
  readonly start: number;
  readonly end: number;
  readonly value: Node;
}

/** An appended entry's text, given the indentation of its line (null: on one line). */
type Rendered = (indent: string | null) => string;

/** How the file is written: one indentation step, its line ending, whether it is one line. */
interface Style {
  readonly unit: string;
  readonly eol: string;
  readonly oneLine: boolean;
}

class Patcher {
  constructor(
    private readonly text: string,
    private readonly style: Style,
  ) {}

  private json(node: Span): string {
    return JSON.stringify(JSON.parse(this.text.slice(node.start, node.end)));
  }

  /** The edits turning `node` into `next`. */
  edits(node: Node, next: unknown): Edit[] {
    if (this.json(node) === JSON.stringify(next)) return [];
    try {
      if (node.kind === "object" && isRecord(next)) return this.object(node, next);
      if (node.kind === "array" && Array.isArray(next)) return this.array(node, next);
    } catch (cause) {
      if (!(cause instanceof Unpatchable)) throw cause;
    }
    return [this.replacement(node, next)];
  }

  private object(node: ObjectNode, next: Record<string, unknown>): Edit[] {
    const keys = Object.keys(next);
    const byKey = new Map(node.members.map((m) => [m.key, m]));
    const kept = keys.filter((k) => byKey.has(k));
    const oldOrder = node.members.map((m) => m.key).filter((k) => Object.hasOwn(next, k));
    if (kept.join("\u0000") !== oldOrder.join("\u0000")) throw new Unpatchable("keys reordered");
    const added = keys.filter((k) => !byKey.has(k));
    if (keys.slice(kept.length).some((k) => byKey.has(k))) throw new Unpatchable("key inserted");
    const removed = new Set(
      node.members.flatMap((m, i) => (Object.hasOwn(next, m.key) ? [] : [i])),
    );
    const inner = node.members.flatMap((m) =>
      Object.hasOwn(next, m.key) ? this.edits(m.value, next[m.key]) : [],
    );
    const sep = this.keySeparator(node);
    const entries = node.members.map((m) => ({ start: m.start, end: m.value.end, value: m.value }));
    const texts = added.map(
      (k) => (indent: string | null) => `${JSON.stringify(k)}${sep}${this.render(next[k], indent)}`,
    );
    return [...inner, ...this.container(node, entries, removed, texts)];
  }

  private array(node: ArrayNode, next: readonly unknown[]): Edit[] {
    const pairs = this.align(node.items, next);
    const removed = new Set<number>();
    const inner: Edit[] = [];
    let appended: unknown[] = [];
    for (const p of pairs) {
      if (p.old !== null && p.next !== null)
        inner.push(...this.edits(node.items[p.old] as Node, next[p.next]));
      else if (p.old !== null) removed.add(p.old);
      else if (p.next !== null) appended = [...appended, next[p.next]];
    }
    const entries = node.items.map((item) => ({ start: item.start, end: item.end, value: item }));
    const texts = appended.map((v) => (indent: string | null) => this.render(v, indent));
    return [...inner, ...this.container(node, entries, removed, texts)];
  }

  /**
   * Old items against new ones: equal values in order (longest common subsequence); between
   * two matches, the unmatched old and new values are paired in order (the same element,
   * changed), the extra old ones removed; new values left over are allowed only at the end.
   */
  private align(items: readonly Node[], next: readonly unknown[]) {
    const a = items.map((n) => this.json(n));
    const b = next.map((v) => JSON.stringify(v));
    const lcs = commonSubsequence(a, b);
    const pairs: { old: number | null; next: number | null }[] = [];
    let i = 0;
    let j = 0;
    for (const [mi, mj] of [...lcs, [a.length, b.length] as const]) {
      const olds = range(i, mi);
      const news = range(j, mj);
      const last = mi === a.length && mj === b.length;
      for (const [k, o] of olds.entries()) pairs.push({ old: o, next: news[k] ?? null });
      const extra = news.slice(olds.length);
      if (extra.length > 0 && !last) throw new Unpatchable("element inserted");
      for (const n of extra) pairs.push({ old: null, next: n });
      if (!last) pairs.push({ old: mi, next: mj });
      i = mi + 1;
      j = mj + 1;
    }
    return pairs;
  }

  /** Removals (with their separators) and appended entries of one container. */
  private container(
    node: Span,
    entries: readonly Entry[],
    removed: ReadonlySet<number>,
    added: readonly Rendered[],
  ): Edit[] {
    const n = entries.length;
    const keptCount = n - removed.size;
    if (n === 0) return added.length === 0 ? [] : [this.fill(node, added)];
    if (keptCount === 0 && added.length > 0) throw new Unpatchable("every entry replaced");
    if (keptCount === 0) return [{ start: node.start + 1, end: node.end - 1, text: "" }];
    const edits = removalRuns(n, removed).map(([i, j]) =>
      j < n - 1
        ? { start: entries[i]?.start ?? 0, end: entries[j + 1]?.start ?? 0, text: "" }
        : { start: entries[i - 1]?.end ?? 0, end: entries[j]?.end ?? 0, text: "" },
    );
    if (added.length === 0) return edits;
    const lastKept = [...range(0, n)].reverse().find((k) => !removed.has(k)) ?? 0;
    const at = entries[lastKept]?.end ?? 0;
    const { sep, indent } = this.separator(node, entries);
    const text = added.map((render) => `${sep}${render(indent)}`).join("");
    return [...edits, { start: at, end: at, text }];
  }

  /** An empty container given its first entries: one per line in a multi-line file. */
  private fill(node: Span, added: readonly Rendered[]): Edit {
    const { unit, eol, oneLine } = this.style;
    if (oneLine) {
      return {
        start: node.start + 1,
        end: node.end - 1,
        text: added.map((r) => r(null)).join(","),
      };
    }
    const outer = this.lineIndent(node.start);
    const indent = `${outer}${unit}`;
    const body = added.map((r) => `${indent}${r(indent)}`).join(`,${eol}`);
    return { start: node.start + 1, end: node.end - 1, text: `${eol}${body}${eol}${outer}` };
  }

  /**
   * What goes before an appended entry (the container's own separator, or the whitespace
   * before its only entry after a comma), and the indentation of its line: null when the
   * container keeps its entries on one line, which then gets the value on one line too.
   */
  private separator(node: Span, entries: readonly Entry[]): { sep: string; indent: string | null } {
    const last = entries[entries.length - 1] as Entry;
    const prev = entries[entries.length - 2];
    const lead = this.text.slice(node.start + 1, last.start);
    const sep =
      prev !== undefined
        ? this.text.slice(prev.end, last.start)
        : lead !== ""
          ? `,${lead}`
          : this.style.oneLine
            ? ","
            : ", ";
    return { sep, indent: sep.includes("\n") ? this.lineIndent(last.start) : null };
  }

  /** The text between a member's key and its value (`: `), from the object or the file. */
  private keySeparator(node: ObjectNode): string {
    const m = node.members[0];
    if (m !== undefined) return this.text.slice(m.keyEnd, m.value.start);
    return this.style.oneLine ? ":" : ": ";
  }

  /** The leading whitespace of the line holding `pos`. */
  private lineIndent(pos: number): string {
    const lineStart = this.text.lastIndexOf("\n", pos - 1) + 1;
    return /^[ \t]*/.exec(this.text.slice(lineStart, pos))?.[0] ?? "";
  }

  /** `value` as the file would write it on a line indented by `indent` (null: on one line). */
  private render(value: unknown, indent: string | null): string {
    if (indent === null || this.style.oneLine) return JSON.stringify(value);
    return JSON.stringify(value, null, this.style.unit).replaceAll(
      "\n",
      `${this.style.eol}${indent}`,
    );
  }

  /** A replaced value: on one line when it was a non-empty value on one line. */
  private replacement(node: Node, next: unknown): Edit {
    const was = this.text.slice(node.start, node.end);
    const oneLine = !was.includes("\n") && (node.kind === "scalar" || was.length > 2);
    const text = this.render(next, oneLine ? null : this.lineIndent(node.start));
    return { start: node.start, end: node.end, text };
  }
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}

/** Maximal runs `[i, j]` of consecutive removed indices below `n`. */
function removalRuns(n: number, removed: ReadonlySet<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    if (!removed.has(i)) continue;
    let j = i;
    while (removed.has(j + 1) && j + 1 < n) j += 1;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

/** Index pairs of a longest common subsequence of `a` and `b`, in order. */
function commonSubsequence(a: readonly string[], b: readonly string[]): [number, number][] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const below = table[i + 1] as number[];
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i += 1;
    else j += 1;
  }
  return out;
}

function apply(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((x, y) => y.start - x.start || y.end - x.end);
  for (let k = 1; k < sorted.length; k += 1) {
    const later = sorted[k - 1] as Edit;
    const earlier = sorted[k] as Edit;
    if (earlier.end > later.start && !(earlier.start === later.start)) {
      throw new Unpatchable("overlapping edits");
    }
  }
  return sorted.reduce((t, e) => `${t.slice(0, e.start)}${e.text}${t.slice(e.end)}`, text);
}

/** One indentation step of `text`: its first indented line's leading whitespace, else two spaces. */
function indentUnit(text: string): string {
  return /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
}

/**
 * `text` edited so that it parses to `next` (key order included), changing only what differs;
 * null when that takes more than local edits (the root replaced, keys reordered, an element
 * inserted mid-array, a duplicate key, text that is not one JSON value), so the caller writes
 * the document afresh.
 */
export function patchJsonText(text: string, next: unknown): string | null {
  try {
    const root = new Reader(text).root();
    const rootText = text.slice(root.start, root.end);
    const style = {
      unit: indentUnit(text),
      eol: text.includes("\r\n") ? "\r\n" : "\n",
      // `{}` is not a style: its first members go one per line.
      oneLine: !rootText.includes("\n") && /[^\s{}[\]]/.test(rootText),
    };
    const edits = new Patcher(text, style).edits(root, next);
    if (edits.some((e) => e.start === root.start && e.end === root.end)) return null;
    const out = apply(text, edits);
    return JSON.stringify(JSON.parse(out)) === JSON.stringify(next) ? out : null;
  } catch (cause) {
    if (cause instanceof Unpatchable || cause instanceof SyntaxError) return null;
    throw cause;
  }
}
