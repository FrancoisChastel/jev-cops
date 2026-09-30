import { DEFAULT_CONTEXT_CONFIG } from "./config.ts";

/** A named content pattern; the name is all that ever leaves this module. */
export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Content patterns that mark a read as a secret read when found in a post event's
 * `stdout_head` (spec §Session case file). None of them backtracks catastrophically.
 */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = Object.freeze([
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { name: "slack-token", pattern: /xox[baprs]-/ },
  { name: "generic-secret", pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}/i },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ/ },
]);

/**
 * Names of the secret patterns found in `text`, each at most once, in table order.
 * Never returns the matched text, so a caller cannot copy a secret into a log.
 */
export function findSecretPatterns(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEX_META, "\\$&");
}

function braceGroup(glob: string, at: number): { regex: string; end: number } | null {
  const end = glob.indexOf("}", at);
  if (end < 0) return null;
  const options = glob
    .slice(at + 1, end)
    .split(",")
    .map(translate);
  return { regex: `(?:${options.join("|")})`, end: end + 1 };
}

function translate(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      out += "(?:/.*)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else {
      const ch = glob[i] ?? "";
      const group = ch === "{" ? braceGroup(glob, i) : null;
      out += group?.regex ?? (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : escapeRegExp(ch));
      i = group?.end ?? i + 1;
    }
  }
  return out;
}

/**
 * Compiles a path glob to an anchored, case-insensitive RegExp. A leading `~` is
 * `home` (daemon config, D-003), matched literally. `**` + `/` matches zero or more
 * directories, a trailing `/**` matches the directory itself and everything below it,
 * `*` and `?` stay within one segment, `{a,b}` is an alternative; the rest is literal.
 */
export function globToRegExp(glob: string, home: string): RegExp {
  const tilde = glob.startsWith("~");
  const head = tilde ? escapeRegExp(home) : "";
  return new RegExp(`^${head}${translate(tilde ? glob.slice(1) : glob)}$`, "i");
}

const COMPILED = new Map<string, RegExp>();

function compiled(glob: string, home: string): RegExp {
  const key = `${home}\u0000${glob}`;
  const cached = COMPILED.get(key);
  if (cached !== undefined) return cached;
  const re = globToRegExp(glob, home);
  COMPILED.set(key, re);
  return re;
}

/**
 * The coding-agent harnesses' own credential files (PLAN-M3 §5), secret whatever the
 * configured globs: Codex `$CODEX_HOME/auth.json` ("Treat `~/.codex/auth.json` like a
 * password", Codex auth docs), OpenCode `~/.local/share/opencode/auth.json` (providers
 * docs), Claude Code `~/.claude/.credentials.json` (Linux; macOS uses the keychain), Pi
 * `~/.pi/agent/auth.json` (Pi changelog). A relocated `CODEX_HOME`/`XDG_DATA_HOME` is not
 * followed.
 */
export const HARNESS_CREDENTIAL_GLOBS: ReadonlyArray<string> = Object.freeze([
  "~/.codex/auth.json",
  "~/.local/share/opencode/auth.json",
  "~/.claude/.credentials.json",
  "~/.pi/agent/auth.json",
]);

/**
 * True when absolute `path` matches a secret glob (default: the spec's list) or is a
 * harness credential file ({@link HARNESS_CREDENTIAL_GLOBS}, always on: a config that
 * replaces the globs cannot drop them). Matching is case-insensitive, since macOS and
 * Windows filesystems are, and errs towards "secret".
 */
export function isSecretPath(
  path: string,
  home: string,
  globs: ReadonlyArray<string> = DEFAULT_CONTEXT_CONFIG.secrets.pathGlobs,
): boolean {
  const all = [...globs, ...HARNESS_CREDENTIAL_GLOBS];
  return all.some((glob) => compiled(glob, home).test(path));
}
