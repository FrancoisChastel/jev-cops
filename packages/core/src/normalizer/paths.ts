import { posix } from "node:path";

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const PATH_PREFIX = /^(?:\/|\.\.?(?:\/|$)|~|\$HOME(?:\/|$)|\$\{HOME\})/;

/**
 * Replaces a leading `~`, `$HOME` or `${HOME}` with `home` (daemon config, D-003).
 * `~user`, `$HOMEDIR` and non-leading occurrences are left alone. Pure string work.
 */
export function expandHome(word: string, home: string): string {
  return word.replace(HOME_PREFIX, () => home);
}

/**
 * Makes `word` absolute against `cwd` and normalizes `.`, `..`, duplicate and trailing
 * slashes with POSIX rules. Never touches the filesystem, so symlinks are not resolved.
 * Returns null for the empty string and for an unexpanded leading `~`.
 */
export function absolutize(word: string, cwd: string): string | null {
  if (word === "" || word.startsWith("~")) return null;
  const joined = word.startsWith("/") ? word : posix.join(cwd, word);
  const normalized = posix.normalize(joined);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** {@link expandHome} then {@link absolutize}: the path a non-shell tool input names. */
export function resolvePath(word: string, cwd: string, home: string): string | null {
  return absolutize(expandHome(word, home), cwd);
}

/** True when `word` is path-shaped on its own: `/…`, `./…`, `../…`, `.`, `..`, `~…`, `$HOME…`. */
export function looksLikePath(word: string): boolean {
  return PATH_PREFIX.test(word);
}
