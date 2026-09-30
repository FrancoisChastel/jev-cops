/**
 * Sets `[daemon] hook_binary` in a `cops.toml` without rewriting the rest of the file (Bun
 * parses TOML but has no writer): the key's line is replaced in place, or added right after
 * the `[daemon]` header, or a `[daemon]` table is appended. The result is parsed back and
 * must equal the old document plus that one key, or nothing is returned (a dotted
 * `daemon.hook_binary`, an inline `daemon = {…}` table or invalid TOML are left to a human).
 */

const HEADER = /^\s*\[\s*daemon\s*\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const KEY = /^\s*hook_binary\s*=/;
/** `daemon.x = …` or `daemon = {…}`: TOML forbids adding a `[daemon]` table next to them. */
const DAEMON_KEY = /^\s*["']?daemon["']?\s*[.=]/;

function lineOf(value: string): string {
  // A JSON string is a valid TOML basic string for any path without control characters.
  return `hook_binary = ${JSON.stringify(value)}`;
}

function edit(lines: readonly string[], value: string): string[] {
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start === -1) {
    const body = lines.at(-1) === "" ? lines.slice(0, -1) : [...lines];
    const gap = body.length === 0 ? [] : [""];
    return [...body, ...gap, "[daemon]", lineOf(value), ""];
  }
  const next = lines.findIndex((l, k) => k > start && ANY_HEADER.test(l));
  const end = next === -1 ? lines.length : next;
  const at = lines.findIndex((l, k) => k > start && k < end && KEY.test(l));
  if (at !== -1) return lines.map((l, k) => (k === at ? lineOf(value) : l));
  return [...lines.slice(0, start + 1), lineOf(value), ...lines.slice(start + 1)];
}

function handEdit(value: string): string {
  return `cannot set [daemon] hook_binary automatically; edit it by hand: ${lineOf(value)}`;
}

function parse(text: string): Record<string, unknown> {
  return Bun.TOML.parse(text) as Record<string, unknown>;
}

function expected(before: string | null, value: string): Record<string, unknown> {
  const doc = before === null ? {} : parse(before);
  const daemon = doc.daemon;
  const table = typeof daemon === "object" && daemon !== null ? daemon : {};
  return { ...doc, daemon: { ...table, hook_binary: value } };
}

/**
 * `before` (null: no file yet) with `[daemon] hook_binary = value`. Throws with "edit it by
 * hand" when the file cannot be edited safely, and on a value with control characters.
 */
export function setDaemonHookBinary(before: string | null, value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("hook_binary must be a plain path");
  const lines = before === null ? [] : before.split("\n");
  if (lines.some((l) => DAEMON_KEY.test(l))) throw new Error(handEdit(value));
  const after = edit(lines, value).join("\n");
  const text = after.endsWith("\n") ? after : `${after}\n`;
  let ok = false;
  try {
    ok = Bun.deepEquals(parse(text), expected(before, value));
  } catch {
    ok = false; // the old or new text does not parse: never write a broken config
  }
  if (!ok) throw new Error(handEdit(value));
  return text;
}

/** `[daemon] hook_binary` of a cops.toml text, or null (no file, no key, not TOML). */
export function readDaemonHookBinary(text: string | null): string | null {
  if (text === null) return null;
  try {
    const daemon = parse(text).daemon as Record<string, unknown> | undefined;
    const value = daemon?.hook_binary;
    return typeof value === "string" ? value : null;
  } catch {
    return null; // a cops.toml that does not parse names no binary
  }
}
