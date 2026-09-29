import { deepFreeze } from "../context/config.ts";
import { safeStringify } from "../normalizer/hash.ts";
import type {
  NetMethod,
  NormalizedCommand,
  NormalizedEvent,
  PathAccess,
} from "../normalizer/types.ts";
import type { PolicyCommand, PolicyEvent } from "./types.ts";

/** Severity of a path access; a path touched twice reports the higher one. */
const ACCESS_RANK: Readonly<Record<PathAccess, number>> = {
  read: 0,
  unknown: 1,
  exec: 2,
  write: 3,
  delete: 4,
};

function copyInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    return structuredClone(input);
  } catch {
    return JSON.parse(safeStringify(input)) as Record<string, unknown>;
  }
}

function netMethod(commands: ReadonlyArray<NormalizedCommand>): NetMethod | null {
  const methods = commands.flatMap((c) => (c.method === undefined ? [] : [c.method]));
  return methods.find((m) => m !== "GET") ?? methods[0] ?? null;
}

function pathAccess(commands: ReadonlyArray<NormalizedCommand>): Record<string, PathAccess> {
  const access = new Map<string, PathAccess>();
  for (const ref of commands.flatMap((c) => c.pathRefs)) {
    const prev = access.get(ref.path);
    if (prev === undefined || ACCESS_RANK[ref.access] > ACCESS_RANK[prev]) {
      access.set(ref.path, ref.access);
    }
  }
  return Object.fromEntries(access);
}

function command(c: NormalizedCommand): PolicyCommand {
  return {
    argv: [...c.argv],
    kind: c.kind,
    verbs: [...c.verbs],
    paths: [...c.targets.paths],
    hosts: [...c.targets.hosts],
    isInterpreter: c.isInterpreter,
    viaInterpreter: c.viaInterpreter,
    remote: c.remote === true,
    method: c.method ?? null,
    raw: c.raw,
  };
}

/**
 * The read-only event a policy sees, built from the normalized event. `call.kind` is
 * the daemon's own classification (stricter than the adapter's, which stays on
 * `call.adapterKind`), `session.task` is the `task` given (the case file's, T11), and
 * the tool input is a deep copy, so a policy can never alter what the harness runs.
 * Deeply frozen.
 */
export function buildPolicyEvent(n: NormalizedEvent, task: string | null): PolicyEvent {
  const { event } = n;
  const sandbox = event.env?.sandbox;
  return deepFreeze({
    id: event.id,
    phase: event.phase,
    harness: event.harness,
    session: {
      id: event.session.id,
      task,
      mode: event.session.mode ?? null,
      parentId: event.session.parent_id,
    },
    actor: { kind: event.actor?.kind ?? "agent", model: event.actor?.model ?? null },
    call: {
      id: event.call.id,
      tool: event.call.tool,
      kind: n.kind,
      adapterKind: event.call.kind,
      cwd: event.call.cwd,
      input: copyInput(event.call.input),
    },
    kind: n.kind,
    commands: n.commands.map(command),
    verbs: [...new Set(n.commands.flatMap((c) => c.verbs))],
    paths: [...n.paths],
    hosts: [...n.hosts],
    opaque: n.opaque.map((o) => ({ ...o })),
    raw: n.raw,
    net: { host: n.hosts[0] ?? null, hosts: [...n.hosts], method: netMethod(n.commands) },
    fs: { paths: [...n.paths], access: pathAccess(n.commands) },
    env: {
      git: event.env?.git === undefined ? null : { ...event.env.git },
      sandbox: { kind: sandbox?.kind ?? "none", name: sandbox?.name ?? null },
    },
  });
}
