import { hasOption, parseArgs } from "./options.ts";
import type { PathAccess, PathArg } from "./types.ts";

/**
 * How a file verb's positionals map to paths: `valueOpts` consume a value, `patternOpts`
 * (when absent) mean the first positional is a pattern or script, `skip` drops leading
 * positionals (a chmod mode), and `last` is the access of the final one (a cp target).
 */
export interface FileRule {
  access: PathAccess;
  valueOpts?: ReadonlyArray<string>;
  patternOpts?: ReadonlyArray<string>;
  skip?: number;
  last?: PathAccess;
}

const GREP_VALUE = ["-e", "-f", "-m", "-A", "-B", "-C", "--regexp", "--file", "--max-count"];
const GREP_PATTERN = ["-e", "-f", "--regexp", "--file"];
const SED_VALUE = ["-e", "-f", "--expression", "--file", "-l", "--line-length"];
const SED_PATTERN = ["-e", "-f", "--expression", "--file"];

/** Positional-argument rules for every verb whose arguments are files. */
export const FILE_RULES: Readonly<Record<string, FileRule>> = {
  cat: { access: "read" },
  head: { access: "read", valueOpts: ["-n", "-c", "--lines", "--bytes"] },
  tail: { access: "read", valueOpts: ["-n", "-c", "--lines", "--bytes", "-s", "--pid"] },
  less: { access: "read" },
  more: { access: "read" },
  wc: { access: "read" },
  strings: { access: "read", valueOpts: ["-n", "-t", "-e"] },
  file: { access: "read", valueOpts: ["-m", "-f"] },
  stat: { access: "read", valueOpts: ["-c", "-f", "--format", "--printf", "-t"] },
  ls: { access: "read", valueOpts: ["-I", "--ignore", "-w", "--width"] },
  grep: { access: "read", valueOpts: GREP_VALUE, patternOpts: GREP_PATTERN },
  rg: {
    access: "read",
    valueOpts: [...GREP_VALUE, "-g", "--glob", "-t", "--type", "-r", "--replace"],
    patternOpts: GREP_PATTERN,
  },
  awk: { access: "read", valueOpts: ["-F", "-v", "-f"], patternOpts: ["-f"] },
  sed: { access: "read", valueOpts: SED_VALUE, patternOpts: SED_PATTERN },
  tee: { access: "write" },
  cp: { access: "read", valueOpts: ["-t", "--target-directory", "-S"], last: "write" },
  mv: { access: "delete", valueOpts: ["-t", "--target-directory", "-S"], last: "write" },
  ln: { access: "read", valueOpts: ["-t", "--target-directory", "-S"], last: "write" },
  touch: { access: "write", valueOpts: ["-t", "-d", "-r", "--date", "--reference"] },
  mkdir: { access: "write", valueOpts: ["-m", "--mode"] },
  chmod: { access: "write", valueOpts: ["--reference"], skip: 1 },
  chown: { access: "write", valueOpts: ["--reference", "--from"], skip: 1 },
  rm: { access: "delete" },
  unlink: { access: "delete" },
  rmdir: { access: "delete" },
  shred: { access: "delete", valueOpts: ["-n", "-s", "--iterations", "--size"] },
  truncate: { access: "delete", valueOpts: ["-s", "--size", "-r", "--reference"] },
};

/**
 * The file arguments of `name args…`; `base` is the argv index of `args[0]`. `access`
 * overrides the rule's default (sed -i writes). Returns [] for a verb with no rule.
 */
export function filePaths(
  name: string,
  args: ReadonlyArray<string>,
  base: number,
  access?: PathAccess,
): PathArg[] {
  const rule = FILE_RULES[name];
  if (rule === undefined) return [];
  const parsed = parseArgs(args, new Set(rule.valueOpts ?? []));
  const needsPattern = rule.patternOpts !== undefined && !hasOption(parsed, rule.patternOpts);
  const files = parsed.positionals.slice((needsPattern ? 1 : 0) + (rule.skip ?? 0));
  return files.map((p, i) => {
    const isLast = rule.last !== undefined && files.length > 1 && i === files.length - 1;
    return {
      value: p.value,
      index: base + p.index,
      access: isLast && rule.last ? rule.last : (access ?? rule.access),
    };
  });
}

/** `["rm", "recursive"?, "force"?]` from rm's flags. */
export function rmVerbs(args: ReadonlyArray<string>): string[] {
  const parsed = parseArgs(args, new Set());
  const recursive = hasOption(parsed, ["-r", "-R", "--recursive"]);
  const force = hasOption(parsed, ["-f", "--force"]);
  return ["rm", ...(recursive ? ["recursive"] : []), ...(force ? ["force"] : [])];
}

/** sed with `-i`/`--in-place` writes, with `-n` alone reads; anything else is unknown. */
export function sedMode(args: ReadonlyArray<string>): "write" | "read" | null {
  const parsed = parseArgs(args, new Set(SED_VALUE));
  const inPlace = parsed.options.some((o) => o.name === "-i" || o.name.startsWith("--in-place"));
  if (inPlace) return "write";
  return hasOption(parsed, ["-n", "--quiet", "--silent"]) ? "read" : null;
}
