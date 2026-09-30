import { hasOption, lookup, parseArgs } from "./options.ts";
import type { PathAccess, PathArg } from "./types.ts";

/**
 * How a file verb's positionals map to paths: `valueOpts` consume a value, `patternOpts`
 * (when absent) mean the first positional is a pattern or script, and `skip` drops leading
 * positionals (a chmod mode). Copy-like verbs (`cp`, `mv`, `ln`, `install`) have their own
 * rule (`copyPaths` in writers.ts).
 */
export interface FileRule {
  access: PathAccess;
  valueOpts?: ReadonlyArray<string>;
  patternOpts?: ReadonlyArray<string>;
  skip?: number;
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
  const rule = lookup(FILE_RULES, name);
  if (rule === undefined) return [];
  const parsed = parseArgs(args, new Set(rule.valueOpts ?? []));
  const needsPattern = rule.patternOpts !== undefined && !hasOption(parsed, rule.patternOpts);
  const files = parsed.positionals.slice((needsPattern ? 1 : 0) + (rule.skip ?? 0));
  return files.map((p) => ({
    value: p.value,
    index: base + p.index,
    access: access ?? rule.access,
  }));
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

const SED_ADDRESS = String.raw`(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)`;
const SED_RANGE = `(?:${SED_ADDRESS}(?:\\s*,\\s*${SED_ADDRESS})?)?`;
const SED_EXEC = new RegExp(String.raw`(?:^|[;\n{}])\s*${SED_RANGE}\s*e(?:\s|;|$)`);
const SED_SUBST_EXEC = /(?:^|[;\n{}\s])s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiImM0-9]*e/;
const SED_WRITE = new RegExp(String.raw`(?:^|[;\n{}])\s*${SED_RANGE}\s*[wW]\s+([^\n]+)`, "g");
const SED_SUBST_WRITE =
  /(?:^|[;\n{}\s])s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiImMe0-9]*w\s+([^\n]+)/g;

/** A sed script as written, with the argv index of the word holding it. */
interface SedScript {
  text: string;
  index: number;
}

function sedScripts(args: ReadonlyArray<string>, base: number): SedScript[] {
  const parsed = parseArgs(args, new Set(SED_VALUE));
  const inline = parsed.options.filter((o) => ["-e", "--expression"].includes(o.name));
  if (inline.length > 0) return inline.map((o) => ({ text: o.value ?? "", index: base + o.index }));
  if (hasOption(parsed, SED_PATTERN)) return [];
  const first = parsed.positionals[0];
  return first === undefined ? [] : [{ text: first.value, index: base + first.index }];
}

/**
 * What sed scripts do beyond reading: `e` and `s///e` execute shell commands (the
 * script is returned as `code`), `w file` and `s///w file` write files. Heuristic:
 * it errs towards flagging, never towards hiding.
 */
export function sedEffects(
  args: ReadonlyArray<string>,
  base: number,
): { code: string | null; writes: PathArg[] } {
  const scripts = sedScripts(args, base);
  const executes = scripts.find((s) => SED_EXEC.test(s.text) || SED_SUBST_EXEC.test(s.text));
  const writes = scripts.flatMap((s) =>
    [...s.text.matchAll(SED_WRITE), ...s.text.matchAll(SED_SUBST_WRITE)].map((m) => ({
      value: (m[m.length - 1] ?? "").trim(),
      index: s.index,
      access: "write" as const,
    })),
  );
  return { code: executes?.text ?? null, writes: writes.filter((w) => w.value !== "") };
}
