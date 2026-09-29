/** One option as written: `name` is `-x` or `--long`; `value` is null for a flag. */
export interface ParsedOption {
  name: string;
  value: string | null;
  /** Index of the argument holding the value (or the flag) within the parsed list. */
  index: number;
}

/** A non-option argument and its index within the parsed list. */
export interface Positional {
  value: string;
  index: number;
}

/** Options and positionals of an argument list, both in source order. */
export interface ParsedArgs {
  options: ParsedOption[];
  positionals: Positional[];
}

interface Cursor {
  args: ReadonlyArray<string>;
  valueOpts: ReadonlySet<string>;
  out: ParsedArgs;
}

function parseLong(c: Cursor, arg: string, i: number): number {
  const eq = arg.indexOf("=");
  if (eq > 0) {
    c.out.options.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1), index: i });
    return i + 1;
  }
  if (c.valueOpts.has(arg)) {
    c.out.options.push({ name: arg, value: c.args[i + 1] ?? null, index: i + 1 });
    return i + 2;
  }
  c.out.options.push({ name: arg, value: null, index: i });
  return i + 1;
}

function parseShortBundle(c: Cursor, arg: string, i: number): number {
  for (let j = 1; j < arg.length; j += 1) {
    const name = `-${arg[j]}`;
    if (!c.valueOpts.has(name)) {
      c.out.options.push({ name, value: null, index: i });
      continue;
    }
    const attached = arg.slice(j + 1);
    if (attached !== "") {
      c.out.options.push({ name, value: attached, index: i });
      return i + 1;
    }
    c.out.options.push({ name, value: c.args[i + 1] ?? null, index: i + 1 });
    return i + 2;
  }
  return i + 1;
}

function isOption(arg: string): boolean {
  return arg.length > 1 && arg.startsWith("-");
}

/**
 * Splits `args` into options and positionals, getopt-style: `--` ends options,
 * `--name=value` and `-xVALUE` attach values, short flags bundle (`-rf`), and an
 * option in `valueOpts` consumes the next argument. With `stopAtPositional`, the first
 * positional and everything after it are positionals (a wrapped command's argv).
 */
export function parseArgs(
  args: ReadonlyArray<string>,
  valueOpts: ReadonlySet<string>,
  stopAtPositional = false,
): ParsedArgs {
  const c: Cursor = { args, valueOpts, out: { options: [], positionals: [] } };
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (arg === "--" || (stopAtPositional && !isOption(arg))) {
      const start = arg === "--" ? i + 1 : i;
      const rest = args.slice(start).map((value, k) => ({ value, index: start + k }));
      c.out.positionals.push(...rest);
      break;
    }
    if (!isOption(arg)) {
      c.out.positionals.push({ value: arg, index: i });
      i += 1;
    } else {
      i = arg.startsWith("--") ? parseLong(c, arg, i) : parseShortBundle(c, arg, i);
    }
  }
  return c.out;
}

/** True when any option in `parsed` has one of `names`. */
export function hasOption(parsed: ParsedArgs, names: ReadonlyArray<string>): boolean {
  return parsed.options.some((o) => names.includes(o.name));
}

/** The value of the last option named in `names`, or null. */
export function optionValue(parsed: ParsedArgs, names: ReadonlyArray<string>): string | null {
  const found = parsed.options.filter((o) => names.includes(o.name) && o.value !== null);
  return found.at(-1)?.value ?? null;
}
