import type { CallKind, Event } from "../schema/event.ts";
import { maxKind } from "./classification.ts";
import { eventKind, normalizeCommand } from "./command.ts";
import { canonicalJson, safeStringify, sha256Hex } from "./hash.ts";
import { urlHost } from "./net.ts";
import { resolvePath } from "./paths.ts";
import { canonicalTool, mcpServer, type ToolRule, toolRule } from "./tools.ts";
import type {
  NetMethod,
  NormalizedCommand,
  NormalizedEvent,
  NormalizedScript,
  PathRef,
} from "./types.ts";

export {
  canonicalTool,
  isInertTool,
  mcpServer,
  TOOL_ALIASES,
  TOOL_RULES,
  type ToolRule,
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

function ruleFor(event: Event): ToolRule | null {
  const { tool, kind, input } = event.call;
  const known = toolRule(tool);
  if (known !== undefined) return known;
  const shellLike = kind === "exec" && stringField(input, "command") !== undefined;
  return shellLike && !MCP_PREFIX.test(tool) ? { reader: "bash" } : null;
}

const SHELL_READERS: ReadonlyArray<ToolRule["reader"]> = ["bash", "shell", "monitor"];

function rawOf(event: Event, rule: ToolRule | null): string {
  const command = stringField(event.call.input, "command");
  const shell = rule !== null && SHELL_READERS.includes(rule.reader);
  return shell && command !== undefined ? command : safeStringify(event.call.input);
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

async function readBash(event: Event, raw: string, opts: NormalizeOptions) {
  const command = stringField(event.call.input, "command");
  if (command === undefined) return unparsed(event, raw);
  return normalizeCommand(command, { cwd: event.call.cwd, home: opts.home });
}

async function readMonitor(event: Event, raw: string, opts: NormalizeOptions) {
  if (stringField(event.call.input, "command") !== undefined) {
    return inBackground(await readBash(event, raw, opts));
  }
  const url = wsUrl(event.call.input);
  return url === undefined ? unparsed(event, raw) : readUrl(url, event, raw);
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
      return backgrounded(event, await readBash(event, raw, opts));
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
    case "spawn":
      return toolScript(event, raw, { kind: "spawn", argv: [tool] });
    case "kind":
      return toolScript(event, raw, { kind: rule.kind, argv: [tool] });
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
  const rule = ruleFor(event);
  const raw = rawOf(event, rule);
  const script = await readTool(rule, event, raw, opts);
  return { event, ...script, stateHash: stateHash(event, script, readAsBash(event, rule)), raw };
}

/** Placeholder raw text when the input itself cannot be rendered (e.g. nested too deeply). */
export const UNRENDERABLE_INPUT = "[unrenderable tool input]";

function failClosed(event: Event): NormalizedEvent {
  let raw = UNRENDERABLE_INPUT;
  try {
    raw = rawOf(event, ruleFor(event));
  } catch {
    // keep the placeholder: the input is unrenderable, which is itself suspicious
  }
  const script = unparsed(event, raw);
  const hash = sha256Hex(`${event.call.tool}\u0000${raw}`);
  return { event, ...script, stateHash: hash, raw };
}

/**
 * Normalizes an event into the daemon's own reading of it. Pure apart from the parser:
 * no filesystem access, `event` is not modified, `event.call.kind` is kept as the
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
