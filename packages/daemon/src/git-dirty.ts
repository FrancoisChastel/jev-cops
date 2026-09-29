import { type BigIntStats, lstatSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether tracked files changed in the worktree, without letting git read any of them.
 * `git status` (and `diff-files` on a racily clean entry) re-hash a file whose stat data
 * changed, which runs the repository's `filter.<driver>.clean`/`process` command: code
 * execution from `.git/config` plus `.git/info/attributes`, both agent-writable, and no
 * `-c` flag can switch off a driver whose name is unknown. So git only lists the index
 * (`ls-files -s --debug`, no worktree access) and the daemon compares stat data itself.
 */

/** One index entry's stat data, as `git ls-files -s --debug -z` prints it. */
export interface IndexEntry {
  readonly mode: string;
  readonly stage: number;
  readonly path: string;
  readonly mtimeSec: number;
  readonly mtimeNsec: number;
  readonly size: number;
}

/** Past this many tracked files dirty is left unknown (the lstat loop must fit the budget). */
export const MAX_WORKTREE_ENTRIES = 20_000;
const DEADLINE_EVERY = 256;
const NS = 1_000_000_000n;
const U32 = 2n ** 32n;

const ENTRY = new RegExp(
  [
    "(\\d{6}) [0-9a-f]{40,64} (\\d)\\t([^\\0]+)\\0",
    "  ctime: \\d+:\\d+\\n",
    "  mtime: (\\d+):(\\d+)\\n",
    "  dev: \\d+\\tino: \\d+\\n",
    "  uid: \\d+\\tgid: \\d+\\n",
    "  size: (\\d+)\\tflags: [0-9a-f]+\\n",
  ].join(""),
  "y",
);

/**
 * Parses the whole listing, or returns null when any part of it does not match the
 * format (`--debug` is documented as unstable; a change must mean "unknown", never
 * "clean").
 */
export function parseIndexListing(text: string): IndexEntry[] | null {
  const entries: IndexEntry[] = [];
  const re = new RegExp(ENTRY);
  while (re.lastIndex < text.length) {
    const m = re.exec(text);
    if (m === null) return null;
    entries.push({
      mode: m[1] ?? "",
      stage: Number(m[2]),
      path: m[3] ?? "",
      mtimeSec: Number(m[4]),
      mtimeNsec: Number(m[5]),
      size: Number(m[6]),
    });
  }
  return entries;
}

function mtimeNs(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

/**
 * True when the file behind `e` differs from what the index recorded: unmerged, missing,
 * of another type, another size or mtime, or racily clean (written in the same tick the
 * index was, which git would settle by reading the contents; here it counts as changed).
 * Submodules are skipped, like `--ignore-submodules`.
 */
export function entryChanged(e: IndexEntry, repo: string, indexNs: bigint): boolean {
  if (e.stage !== 0) return true;
  if (e.mode === "160000") return false;
  let st: BigIntStats;
  try {
    st = lstatSync(join(repo, e.path), { bigint: true });
  } catch {
    return true;
  }
  if (e.mode.startsWith("120") ? !st.isSymbolicLink() : !st.isFile()) return true;
  if (st.size % U32 !== BigInt(e.size) || st.mtimeNs / NS !== BigInt(e.mtimeSec)) return true;
  if (e.mtimeNsec !== 0 && st.mtimeNs % NS !== BigInt(e.mtimeNsec)) return true;
  const entryNs = BigInt(e.mtimeSec) * NS + BigInt(e.mtimeNsec);
  return e.mtimeNsec === 0 ? BigInt(e.mtimeSec) >= indexNs / NS : entryNs >= indexNs;
}

/**
 * Whether any tracked file changed, from the `ls-files -s --debug -z` listing of the
 * repo at `repo` and the index file at `indexPath`; null (unknown) when the listing does
 * not parse, has too many entries, the index cannot be read, or `deadline`
 * (`performance.now()` time) passes.
 */
export function worktreeDirty(
  listing: string,
  repo: string,
  indexPath: string,
  deadline: number,
): boolean | null {
  const entries = parseIndexListing(listing);
  if (entries === null || entries.length > MAX_WORKTREE_ENTRIES) return null;
  if (entries.length === 0) return false;
  const indexNs = mtimeNs(indexPath);
  if (indexNs === null) return null;
  for (const [i, e] of entries.entries()) {
    if (i % DEADLINE_EVERY === 0 && performance.now() > deadline) return null;
    if (entryChanged(e, repo, indexNs)) return true;
  }
  return false;
}
