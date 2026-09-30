/**
 * A minimal line diff for `cops install --dry-run` (what would change in a settings file):
 * longest-common-subsequence over lines, unified-style prefixes (` `, `-`, `+`), two lines
 * of context around each change and ` …` for the lines skipped between.
 */

type Op = { readonly kind: " " | "-" | "+"; readonly text: string };

const CONTEXT = 2;
/** Above this many table cells the diff is a whole replacement (keeps memory bounded). */
const MAX_CELLS = 4_000_000;

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const t = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = t[i] as Uint32Array;
    const next = t[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return t;
}

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const removed = a.map((text): Op => ({ kind: "-", text }));
  const added = b.map((text): Op => ({ kind: "+", text }));
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return [...removed, ...added];
  const t = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((t[i + 1]?.[j] ?? 0) >= (t[i]?.[j + 1] ?? 0)) {
      ops.push(removed[i++] as Op);
    } else {
      ops.push(added[j++] as Op);
    }
  }
  return [...ops, ...removed.slice(i), ...added.slice(j)];
}

/** The ops within {@link CONTEXT} of a change, with one ` …` per skipped run. */
function withContext(ops: readonly Op[]): string[] {
  const near = new Uint8Array(ops.length);
  ops.forEach((op, k) => {
    if (op.kind === " ") return;
    near.fill(1, Math.max(0, k - CONTEXT), Math.min(ops.length, k + CONTEXT + 1));
  });
  const out: string[] = [];
  ops.forEach((op, k) => {
    if (near[k] === 1) out.push(`${op.kind}${op.text}`);
    else if (out.at(-1) !== " …") out.push(" …");
  });
  return out;
}

/**
 * The diff from `before` to `after` for `label` (null = the file is absent), or "" when
 * they are equal.
 */
export function lineDiff(before: string | null, after: string | null, label: string): string {
  if (before === after) return "";
  const header = [
    `--- ${label}${before === null ? " (absent)" : ""}`,
    `+++ ${label}${after === null ? " (removed)" : ""}`,
  ];
  const ops = diffOps(linesOf(before ?? ""), linesOf(after ?? ""));
  return [...header, ...withContext(ops)].join("\n");
}
