import { type Classification, plain } from "./classification.ts";
import { lookup, parseArgs } from "./options.ts";
import type { NormalizedCommand } from "./types.ts";

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
  /** Environment variables that relocate or drop them (with {@link RELOCATING_ENV}). */
  env: readonly string[];
}

/** Variables that move every harness's config directory (`~`, `$XDG_CONFIG_HOME`). */
const RELOCATING_ENV = ["HOME", "XDG_CONFIG_HOME"];

/**
 * Per CLI. Claude Code from its CLI reference (v2.1.285; `config` kept for older
 * versions); Pi from its current CLI; Codex from `codex --help`/`codex exec --help`
 * 0.153.4 and `hooks.md` (`--dangerously-bypass-hook-trust`, `--ignore-user-config`,
 * `--ignore-rules`, `--enable`/`--disable <FEATURE>`, `-c key=value`, `--profile`,
 * `$CODEX_HOME`); OpenCode from `opencode --help` 1.18.33 and `flag.ts` (`--pure`,
 * `OPENCODE_PURE`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_CONFIG*`). Over-inclusive
 * on purpose: a subcommand that does not exist costs nothing, a missed one hides a
 * config change.
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
    env: ["CLAUDE_CONFIG_DIR"],
  },
  codex: {
    config: {
      mcp: "any",
      plugin: "any",
      features: ["enable", "disable"],
      ...{ login: "self", logout: "self", update: "self" },
    },
    flags: ["--dangerously-bypass-hook-trust", "--ignore-rules", "--ignore-user-config"].concat([
      "--disable",
      "--enable",
      "-c",
      "--config",
      "-p",
      "--profile",
      "--remote",
    ]),
    env: ["CODEX_HOME"],
  },
  opencode: {
    config: {
      mcp: "any",
      plugin: "any",
      plug: "any",
      auth: ["login", "logout"],
      providers: ["login", "logout"],
      agent: ["create"],
      github: ["install"],
      ...{ upgrade: "self", uninstall: "self", import: "self" },
    },
    flags: ["--pure"],
    env: ["OPENCODE_PURE", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_CONFIG"].concat([
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
    ]),
  },
  pi: {
    config: { install: "self", remove: "self", uninstall: "self", update: "self", config: "self" },
    flags: ["--no-extensions", "-ne", "-e", "--extension"],
    env: ["PI_CODING_AGENT_DIR"],
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

/**
 * `command` with the {@link HARNESS_CONFIG_VERB} verb added when it runs a harness CLI with
 * a variable in its environment that relocates or drops that harness's hooks, settings or
 * plugins (`CODEX_HOME=/tmp/x codex exec …`, `env OPENCODE_PURE=1 opencode run …`,
 * `HOME=/tmp/h claude -p …`): the nested agent would run unjudged (D-114 pattern). Works
 * on a normalized command because a prefix assignment never reaches the classifier.
 */
export function withHarnessEnv(command: NormalizedCommand): NormalizedCommand {
  if (command.verbs.includes(HARNESS_CONFIG_VERB)) return command;
  const cli = command.verbs.map((v) => lookup(HARNESS, v)).find((h) => h !== undefined);
  if (cli === undefined) return command;
  const names = [...RELOCATING_ENV, ...cli.env];
  const relocated = Object.keys(command.env).some((name) => names.includes(name));
  return relocated ? { ...command, verbs: [...command.verbs, HARNESS_CONFIG_VERB] } : command;
}
