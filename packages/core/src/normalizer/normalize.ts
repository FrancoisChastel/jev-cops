import type { CallKind, Event } from "../schema/event.ts";
import { maxKind } from "./classification.ts";
import { eventKind, normalizeCommand } from "./command.ts";
import { canonicalJson, safeStringify, sha256Hex } from "./hash.ts";
import { urlHost } from "./net.ts";
import { hunkCommands, PATCH_VERB, parsePatch } from "./patch.ts";
import { resolvePath } from "./paths.ts";
import { canonicalTool, mcpServer, type ToolRule, toolRule } from "./tools.ts";
import type {
  NetMethod,
  NormalizedCommand,
  NormalizedEvent,
  NormalizedScript,
  OpaqueSpan,
  PathRef,
} from "./types.ts";

export {
  canonicalTool,
  HARNESS_TOOL_ALIASES,
  HARNESS_TOOL_RULES,
  isInertTool,
  mcpServer,
  TOOL_ALIASES,
  TOOL_RULES,
  type ToolRule,
  type ToolTable,
  toolRule,
} from "./tools.ts";
export type * from "./types.ts";

/** What `~`/`$HOME` expand to: daemon config, never the event (D-003). */
export interface NormalizeOptions {
  home: string;
}

function stringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = Object.hasOwn(input, field) ? input[field] : undefined;
  return typeof value === "string" ? value : undefined;
}

const MCP_PREFIX = /^mcp(?::|__)/;

/**
 * The rule the event's input is read with: its tool's on the event's own harness (D-054,
 * {@link toolRule}), else `bash` for an unknown non-MCP `exec` tool with a string
 * `command`, else null (read as `other`).
 */
export function eventToolRule(event: Event): ToolRule | null {
  const { tool, kind, input } = event.call;
  const known = toolRule(tool, event.harness);
  if (known !== undefined) return known;
  const shellLike = kind === "exec" && stringField(input, "command") !== undefined;
  return shellLike && !MCP_PREFIX.test(tool) ? { reader: "bash" } : null;
}

/** The input field holding the text a shell-like or patch rule reads. */
function textField(rule: ToolRule | null): string | undefined {
  switch (rule?.reader) {
    case "bash":
    case "monitor":
      return "command";
    case "shell":
      return rule.field ?? "command";
    case "patch":
      return rule.field;
    default:
      return undefined;
  }
}

/** The command, script or patch text the rule reads, else the input as JSON. */
function rawOf(event: Event, rule: ToolRule | null): string {
  const field = textField(rule);
  const text = field === undefined ? undefined : stringField(event.call.input, field);
  return text ?? safeStringify(event.call.input);
}

/** True when the input was read as a bash command, so the commands already cover it. */
function readAsBash(event: Event, rule: ToolRule | null): boolean {
  const reader = rule?.reader;
  const command = stringField(event.call.input, "command");
  return reader === "bash" || (reader === "monitor" && command !== undefined);
}

interface ToolCommandParts {
  kind: CallKind;
  argv: string[];
  pathRefs?: PathRef[];
  hosts?: string[];
  method?: NetMethod;
  verbs?: string[];
}

function toolScript(event: Event, raw: string, parts: ToolCommandParts): NormalizedScript {
  const pathRefs = parts.pathRefs ?? [];
  const hosts = parts.hosts ?? [];
  const command: NormalizedCommand = {
    argv: parts.argv,
    env: {},
    redirects: [],
    heredocs: [],
    raw,
    kind: parts.kind,
    targets: { paths: pathRefs.map((r) => r.path), hosts },
    pathRefs,
    verbs: parts.verbs ?? [event.call.tool.toLowerCase()],
    isInterpreter: false,
    viaInterpreter: false,
    ...(parts.method === undefined ? {} : { method: parts.method }),
  };
  return { ...emptyScript(parts.kind), commands: [command], paths: command.targets.paths, hosts };
}

function emptyScript(kind: CallKind): NormalizedScript {
  return { kind, commands: [], paths: [], hosts: [], opaque: [], decodedLiterals: [] };
}

function unparsed(event: Event, raw: string): NormalizedScript {
  const script = toolScript(event, raw, { kind: "exec", argv: [raw] });
  return { ...script, opaque: [{ reason: "parse-error", span: raw }] };
}

function readPath(
  rule: Extract<ToolRule, { reader: "path" }>,
  event: Event,
  raw: string,
  opts: NormalizeOptions,
): NormalizedScript {
  const { tool, input, cwd } = event.call;
  const value = rule.fields.map((f) => stringField(input, f)).find((v) => v !== undefined);
  const path = value === undefined ? null : resolvePath(value, cwd, opts.home);
  const pathRefs =
    value === undefined || path === null ? [] : [{ raw: value, path, access: rule.access }];
  return toolScript(event, raw, {
    kind: rule.kind,
    argv: value === undefined ? [tool] : [tool, value],
    pathRefs,
  });
}

function readUrl(url: string | undefined, event: Event, raw: string): NormalizedScript {
  const host = url === undefined ? null : urlHost(url);
  return toolScript(event, raw, {
    kind: "net",
    argv: url === undefined ? [event.call.tool] : [event.call.tool, url],
    hosts: host === null ? [] : [host],
    method: "GET",
  });
}

/**
 * The command runs detached (`run_in_background`, a Monitor): every local command gets
 * the `background` verb and is at least a `spawn`, as a shell `&` makes it.
 */
function inBackground(script: NormalizedScript): NormalizedScript {
  const commands = script.commands.map(
    (c): NormalizedCommand =>
      c.remote === true
        ? c
        : {
            ...c,
            kind: maxKind(c.kind, "spawn"),
            verbs: c.verbs.includes("background") ? c.verbs : [...c.verbs, "background"],
          },
  );
  return { ...script, commands, kind: eventKind(commands, script.opaque) };
}

function backgrounded(event: Event, script: NormalizedScript): NormalizedScript {
  return event.call.input.run_in_background === true ? inBackground(script) : script;
}

/** A Monitor's WebSocket source: `input.ws.url`. */
function wsUrl(input: Readonly<Record<string, unknown>>): string | undefined {
  const ws = Object.hasOwn(input, "ws") ? input.ws : undefined;
  if (typeof ws !== "object" || ws === null || !Object.hasOwn(ws, "url")) return undefined;
  const url: unknown = (ws as Record<string, unknown>).url;
  return typeof url === "string" ? url : undefined;
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/** A script whose commands changed: its paths and kind recomputed as normalizeCommand does. */
function rebuilt(
  script: NormalizedScript,
  commands: NormalizedCommand[],
  opaque: OpaqueSpan[],
): NormalizedScript {
  const paths = unique(commands.flatMap((c) => c.targets.paths));
  return { ...script, commands, opaque, paths, kind: eventKind(commands, opaque) };
}

/**
 * The working directory a call names (OpenCode's `bash` `workdir`), read like a leading
 * `cd <dir> &&`: a command of kind `other` naming the directory with `unknown` access, so
 * scope and config-tamper see it and the state hash tells two directories apart.
 */
function withWorkdir(script: NormalizedScript, workdir: string, dir: string): NormalizedScript {
  const cd: NormalizedCommand = {
    argv: ["cd", workdir],
    env: {},
    redirects: [],
    heredocs: [],
    raw: workdir,
    kind: "other",
    targets: { paths: [dir], hosts: [] },
    pathRefs: [{ raw: workdir, path: dir, access: "unknown" }],
    verbs: ["cd"],
    isInterpreter: false,
    viaInterpreter: false,
  };
  return rebuilt(script, [cd, ...script.commands], script.opaque);
}

type BashRule = Extract<ToolRule, { reader: "bash" }>;

async function readBash(event: Event, rule: BashRule, raw: string, opts: NormalizeOptions) {
  const { input, cwd } = event.call;
  const command = stringField(input, "command");
  if (command === undefined) return unparsed(event, raw);
  const workdir = rule.workdir === undefined ? undefined : stringField(input, rule.workdir);
  const dir = workdir === undefined ? null : resolvePath(workdir, cwd, opts.home);
  const script = await normalizeCommand(command, { cwd: dir ?? cwd, home: opts.home });
  return workdir === undefined || dir === null ? script : withWorkdir(script, workdir, dir);
}

async function readMonitor(event: Event, raw: string, opts: NormalizeOptions) {
  if (stringField(event.call.input, "command") !== undefined) {
    return inBackground(await readBash(event, { reader: "bash" }, raw, opts));
  }
  const url = wsUrl(event.call.input);
  return url === undefined ? unparsed(event, raw) : readUrl(url, event, raw);
}

/**
 * An `apply_patch` tool (Codex `command`, OpenCode `patchText`): one command per file
 * operation. A malformed patch keeps the paths it names and adds a `parse-error` span
 * (D-005); one that names nothing is {@link unparsed}; an empty patch is a bare write.
 */
function readPatch(
  rule: Extract<ToolRule, { reader: "patch" }>,
  event: Event,
  raw: string,
  opts: NormalizeOptions,
): NormalizedScript {
  const { tool, input, cwd } = event.call;
  const text = stringField(input, rule.field);
  const parsed = text === undefined ? null : parsePatch(text);
  if (parsed === null || (!parsed.valid && parsed.hunks.length === 0)) return unparsed(event, raw);
  if (parsed.hunks.length === 0) {
    return toolScript(event, raw, { kind: "fs.write", argv: [tool], verbs: [PATCH_VERB] });
  }
  const commands = hunkCommands(parsed.hunks, { tool, cwd, home: opts.home });
  const opaque: OpaqueSpan[] = parsed.valid ? [] : [{ reason: "parse-error", span: raw }];
  return rebuilt(emptyScript("other"), commands, opaque);
}

/** An MCP tool: `other`, with the server recorded as the verb `mcp:<server>`. */
function readOther(event: Event, raw: string): NormalizedScript {
  const server = mcpServer(event.call.tool);
  if (server === null) return emptyScript("other");
  const argv = [canonicalTool(event.call.tool)];
  return toolScript(event, raw, { kind: "other", argv, verbs: ["mcp", `mcp:${server}`] });
}

async function readTool(
  rule: ToolRule | null,
  event: Event,
  raw: string,
  opts: NormalizeOptions,
): Promise<NormalizedScript> {
  const tool = event.call.tool;
  switch (rule?.reader) {
    case "bash":
      return backgrounded(event, await readBash(event, rule, raw, opts));
    case "shell": {
      const script = toolScript(event, raw, { kind: "exec", argv: [raw] });
      return backgrounded(event, { ...script, opaque: [{ reason: "interpreter", span: raw }] });
    }
    case "monitor":
      return readMonitor(event, raw, opts);
    case "path":
      return readPath(rule, event, raw, opts);
    case "url":
      return readUrl(stringField(event.call.input, rule.field), event, raw);
    case "patch":
      return readPatch(rule, event, raw, opts);
    case "spawn":
      return toolScript(event, raw, { kind: "spawn", argv: [tool] });
    case "kind": {
      const verbs = [tool.toLowerCase(), ...(rule.verbs ?? [])];
      return toolScript(event, raw, { kind: rule.kind, argv: [tool], verbs });
    }
    case "inert":
      return toolScript(event, raw, { kind: "other", argv: [tool], verbs: ["inert"] });
    default:
      return readOther(event, raw);
  }
}

/**
 * sha256 over a canonical JSON of the normalized shape: tool, kind, per-command argv,
 * env, redirects, heredoc bodies, kind, verbs, targets and the remote flag (only when
 * set, so local-only hashes are unchanged), the path and host unions,
 * the sorted opaque reasons, and (for non-shell tools) the tool input. Ids, timestamps,
 * spans and the agent's description are excluded, and argv is post-quote-removal, so
 * whitespace and quoting differences hash equal.
 */
export function stateHash(event: Event, script: NormalizedScript, shell: boolean): string {
  return sha256Hex(
    canonicalJson({
      tool: event.call.tool,
      kind: script.kind,
      commands: script.commands.map((c) => ({
        argv: c.argv,
        env: c.env,
        redirects: c.redirects,
        heredocs: c.heredocs,
        kind: c.kind,
        verbs: c.verbs,
        targets: c.targets,
        ...(c.remote === true ? { remote: true } : {}),
      })),
      paths: script.paths,
      hosts: script.hosts,
      opaque: [...new Set(script.opaque.map((o) => o.reason))].sort(),
      input: shell ? null : event.call.input,
    }),
  );
}

async function normalizeUnguarded(event: Event, opts: NormalizeOptions): Promise<NormalizedEvent> {
  const rule = eventToolRule(event);
  const raw = rawOf(event, rule);
  const script = await readTool(rule, event, raw, opts);
  return { event, ...script, stateHash: stateHash(event, script, readAsBash(event, rule)), raw };
}

/** Placeholder raw text when the input itself cannot be rendered (e.g. nested too deeply). */
export const UNRENDERABLE_INPUT = "[unrenderable tool input]";

function failClosed(event: Event): NormalizedEvent {
  let raw = UNRENDERABLE_INPUT;
  try {
    raw = rawOf(event, eventToolRule(event));
  } catch {
    // keep the placeholder: the input is unrenderable, which is itself suspicious
  }
  const script = unparsed(event, raw);
  const hash = sha256Hex(`${event.call.tool}\u0000${raw}`);
  return { event, ...script, stateHash: hash, raw };
}

/**
 * Normalizes an event into the daemon's own reading of it. The tool is read with the
 * rule of the event's own harness ({@link HARNESS_TOOL_RULES}). Pure apart from the
 * parser: no filesystem access, `event` is not modified, `event.call.kind` is kept as the
 * adapter sent it while `kind` is the daemon's classification. Never throws: any
 * internal failure yields an `exec` event with a `parse-error` span over `raw` (D-005).
 */
export async function normalize(event: Event, opts: NormalizeOptions): Promise<NormalizedEvent> {
  try {
    return await normalizeUnguarded(event, opts);
  } catch {
    return failClosed(event);
  }
}
