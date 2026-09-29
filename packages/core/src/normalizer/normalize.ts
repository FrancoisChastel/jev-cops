import type { CallKind, Event } from "../schema/event.ts";
import { normalizeCommand } from "./command.ts";
import { canonicalJson, safeStringify, sha256Hex } from "./hash.ts";
import { urlHost } from "./net.ts";
import { lookup } from "./options.ts";
import { resolvePath } from "./paths.ts";
import type {
  NetMethod,
  NormalizedCommand,
  NormalizedEvent,
  NormalizedScript,
  PathAccess,
  PathRef,
} from "./types.ts";

export type * from "./types.ts";

/** What `~`/`$HOME` expand to: daemon config, never the event (D-003). */
export interface NormalizeOptions {
  home: string;
}

/**
 * How one tool's input is read. `bash` parses `input.command`; `path` reads the first
 * string among `fields` as a file path; `url` reads `input[field]` as a URL; `spawn`
 * reads nothing (prompt and description stay in `raw`).
 */
export type ToolRule =
  | { reader: "bash" }
  | { reader: "path"; fields: ReadonlyArray<string>; kind: CallKind; access: PathAccess }
  | { reader: "url"; field: string }
  | { reader: "spawn" };

const WRITE_RULE: ToolRule = {
  reader: "path",
  fields: ["file_path"],
  kind: "fs.write",
  access: "write",
};

/**
 * The single tool → input-field mapping, so adapters stay policy-free. Tools not listed
 * are `other` (raw = JSON of the input), except an unknown non-`mcp:` tool whose
 * adapter kind is `exec` and whose input has a string `command`: that is parsed as bash.
 */
export const TOOL_RULES: Readonly<Record<string, ToolRule>> = {
  Bash: { reader: "bash" },
  Edit: WRITE_RULE,
  Write: WRITE_RULE,
  MultiEdit: WRITE_RULE,
  NotebookEdit: { ...WRITE_RULE, fields: ["file_path", "notebook_path"] },
  Read: { reader: "path", fields: ["file_path"], kind: "fs.read", access: "read" },
  WebFetch: { reader: "url", field: "url" },
  Task: { reader: "spawn" },
};

function stringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = Object.hasOwn(input, field) ? input[field] : undefined;
  return typeof value === "string" ? value : undefined;
}

function ruleFor(event: Event): ToolRule | null {
  const { tool, kind, input } = event.call;
  const known = lookup(TOOL_RULES, tool);
  if (known !== undefined) return known;
  const shellLike = kind === "exec" && stringField(input, "command") !== undefined;
  return shellLike && !tool.startsWith("mcp:") ? { reader: "bash" } : null;
}

function rawOf(event: Event, rule: ToolRule | null): string {
  const command = stringField(event.call.input, "command");
  return rule?.reader === "bash" && command !== undefined
    ? command
    : safeStringify(event.call.input);
}

interface ToolCommandParts {
  kind: CallKind;
  argv: string[];
  pathRefs?: PathRef[];
  hosts?: string[];
  method?: NetMethod;
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
    verbs: [event.call.tool.toLowerCase()],
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

function readUrl(field: string, event: Event, raw: string): NormalizedScript {
  const url = stringField(event.call.input, field);
  const host = url === undefined ? null : urlHost(url);
  return toolScript(event, raw, {
    kind: "net",
    argv: url === undefined ? [event.call.tool] : [event.call.tool, url],
    hosts: host === null ? [] : [host],
    method: "GET",
  });
}

async function readTool(
  rule: ToolRule | null,
  event: Event,
  raw: string,
  opts: NormalizeOptions,
): Promise<NormalizedScript> {
  switch (rule?.reader) {
    case "bash": {
      const command = stringField(event.call.input, "command");
      if (command === undefined) return unparsed(event, raw);
      return normalizeCommand(command, { cwd: event.call.cwd, home: opts.home });
    }
    case "path":
      return readPath(rule, event, raw, opts);
    case "url":
      return readUrl(rule.field, event, raw);
    case "spawn":
      return toolScript(event, raw, { kind: "spawn", argv: [event.call.tool] });
    default:
      return emptyScript("other");
  }
}

/**
 * sha256 over a canonical JSON of the normalized shape: tool, kind, per-command argv,
 * env, redirects, heredoc bodies, kind, verbs and targets, the path and host unions,
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
  return { event, ...script, stateHash: stateHash(event, script, rule?.reader === "bash"), raw };
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
