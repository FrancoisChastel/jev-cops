import { type Classification, plain } from "./classification.ts";
import { lookup, parseArgs } from "./options.ts";

/**
 * Coding-agent harness CLIs run from a shell. Every invocation starts or drives another
 * agent session or changes the harness itself, so it is a `spawn` (PLAN-M1 §4.1). The
 * invocations that change the harness's hooks, settings, plugins or extensions carry the
 * {@link HARNESS_CONFIG_VERB} verb, so policies (`config-tamper`) match them without
 * re-reading argv.
 */
export const HARNESS_CLIS = ["claude", "codex", "opencode", "pi"] as const;

/** Verb of a harness CLI invocation that changes the harness's configuration. */
export const HARNESS_CONFIG_VERB = "harness-config";

/**
 * Which uses of a subcommand change config: `self` (the subcommand itself, e.g.
 * `claude update`), `any` (every action after it except a read-only one, e.g.
 * `claude mcp add`), or only the listed actions (`claude auto-mode reset`).
 */
type ConfigActions = "self" | "any" | readonly string[];

interface HarnessCli {
  config: Readonly<Record<string, ConfigActions>>;
  /** Flags that load, replace or drop hooks, settings or extensions for the session. */
  flags: readonly string[];
}

/**
 * Per CLI. Claude Code from its CLI reference (v2.1.285; `config` kept for older
 * versions); Codex, OpenCode and Pi from their current CLIs. Over-inclusive on purpose:
 * a subcommand that does not exist costs nothing, a missed one hides a config change.
 */
const HARNESS: Readonly<Record<string, HarnessCli>> = {
  claude: {
    config: {
      config: "any",
      mcp: "any",
      plugin: "any",
      plugins: "any",
      "auto-mode": ["reset"],
      auth: ["login", "logout"],
      project: ["purge"],
      ...{ install: "self", update: "self", import: "self", "migrate-installer": "self" },
    },
    flags: ["--bare", "--safe-mode", "--settings", "--setting-sources", "--plugin-dir"].concat([
      "--mcp-config",
      "--dangerously-load-development-channels",
    ]),
  },
  codex: {
    config: { mcp: "any", features: ["enable", "disable"], login: "self", logout: "self" },
    flags: [],
  },
  opencode: {
    config: {
      mcp: "any",
      plugin: "any",
      auth: ["login", "logout"],
      agent: ["create"],
      github: ["install"],
      ...{ upgrade: "self", uninstall: "self", import: "self" },
    },
    flags: [],
  },
  pi: {
    config: { install: "self", remove: "self", uninstall: "self", update: "self", config: "self" },
    flags: ["--no-extensions", "-ne", "-e", "--extension"],
  },
};

/** Actions that only read: `claude mcp list`, `codex features list`, `claude mcp serve`. */
const READ_ONLY_ACTIONS = new Set(["list", "ls", "get", "show", "status", "help", "serve"]);
/** Words that group actions: `claude plugin marketplace add`. */
const ACTION_GROUPS = new Set(["marketplace"]);

function changesConfig(actions: ConfigActions, words: ReadonlyArray<string>): boolean {
  if (actions === "self") return true;
  const [first, second] = words;
  const action = first !== undefined && ACTION_GROUPS.has(first) ? second : first;
  if (action === undefined) return false;
  return actions === "any" ? !READ_ONLY_ACTIONS.has(action) : actions.includes(action);
}

function hasFlag(args: ReadonlyArray<string>, flags: readonly string[]): boolean {
  return args.some((a) => flags.includes(a) || flags.some((f) => a.startsWith(`${f}=`)));
}

/**
 * Classifies `claude|codex|opencode|pi args…` (null for any other command): kind
 * `spawn`, verbs `[cli, subcommand?, "harness-config"?]`. The subcommand is the first
 * positional that names one of the CLI's config subcommands, so an option value before
 * it (`claude --model opus mcp add …`) cannot hide it; prompt text is never a verb.
 */
export function classifyHarness(name: string, args: ReadonlyArray<string>): Classification | null {
  const cli = lookup(HARNESS, name);
  if (cli === undefined) return null;
  const positionals = parseArgs(args, new Set()).positionals.map((p) => p.value);
  const at = positionals.findIndex((w) => Object.hasOwn(cli.config, w));
  const sub = at < 0 ? undefined : positionals[at];
  const actions = sub === undefined ? undefined : lookup(cli.config, sub);
  const byAction = actions !== undefined && changesConfig(actions, positionals.slice(at + 1));
  const config = byAction || hasFlag(args, cli.flags);
  const verbs = [name, ...(sub === undefined ? [] : [sub])];
  return plain("spawn", config ? [...verbs, HARNESS_CONFIG_VERB] : verbs);
}
