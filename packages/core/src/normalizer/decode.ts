import { posix } from "node:path";
import { looksLikePath } from "./paths.ts";
import type { DecodedLiteral } from "./types.ts";

/** Upper bound on the characters of one word that are decoded (64 KB). */
export const MAX_DECODE_CHARS = 65_536;

const MIN_BASE64_CHARS = 8;
const PLAIN_BASE64_MIN_CHARS = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_PUNCTUATION = /[+/=]/;
const HEX = /^(?:[0-9a-fA-F]{2}){4,}$/;
const NON_PRINTABLE = /[\p{Cc}\p{Cs}�]/u;
const ALLOWED_CONTROLS = /[\t\n\r]/g;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function printable(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  return NON_PRINTABLE.test(text.replace(ALLOWED_CONTROLS, "")) ? null : text;
}

function isBase64Candidate(word: string): boolean {
  if (word.length < MIN_BASE64_CHARS || word.length % 4 !== 0 || !BASE64.test(word)) return false;
  return BASE64_PUNCTUATION.test(word) || word.length >= PLAIN_BASE64_MIN_CHARS;
}

function decodeHex(word: string): string | null {
  if (!HEX.test(word)) return null;
  const capped = word.slice(0, MAX_DECODE_CHARS);
  return printable(Buffer.from(capped, "hex"));
}

function decodeBase64(word: string): string | null {
  if (!isBase64Candidate(word)) return null;
  const capped = word.slice(0, MAX_DECODE_CHARS);
  return printable(Buffer.from(capped, "base64"));
}

/**
 * Decodes a literal argument word written as hex (at least 4 bytes) or base64 (at
 * least 8 chars, and either base64 punctuation or 16+ chars), keeping it only when
 * the result is printable UTF-8. Paths and options are never decoded; at most
 * {@link MAX_DECODE_CHARS} characters of a word are read. Hex wins when both match.
 */
export function decodeLiteral(word: string): DecodedLiteral | null {
  if (word.startsWith("-") || looksLikePath(word)) return null;
  const fromHex = decodeHex(word);
  if (fromHex !== null) return { encoding: "hex", raw: word, decoded: fromHex };
  const fromBase64 = decodeBase64(word);
  if (fromBase64 !== null) return { encoding: "base64", raw: word, decoded: fromBase64 };
  return null;
}

function hasShortFlag(args: ReadonlyArray<string>, flag: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(flag));
}

/**
 * True when `argv` decodes its input: `base64 -d|--decode|-D`, `xxd -r`,
 * `openssl enc -d` or `openssl base64 -d`. The `| sh` stage after one of these is
 * what turns a pipeline into a decoded pipe (T5).
 */
export function isDecoder(argv: ReadonlyArray<string>): boolean {
  const name = posix.basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (name === "base64" || name === "base32") {
    return args.includes("--decode") || hasShortFlag(args, "d") || hasShortFlag(args, "D");
  }
  if (name === "xxd") return args.includes("--revert") || hasShortFlag(args, "r");
  if (name === "openssl") {
    const sub = args[0];
    return (sub === "enc" || sub === "base64") && args.includes("-d");
  }
  return false;
}
