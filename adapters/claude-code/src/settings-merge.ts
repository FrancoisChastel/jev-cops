/**
 * Merging jev-cops's hook groups into a Claude Code settings object and taking them out
 * again (PLAN-M1 §4.3 `mergeHooks`, D-075 proposal). Pure: inputs are never mutated, key
 * order and every key the installer does not own are kept, and only handlers
 * {@link isJevCopsEntry} recognises are removed.
 */
import {
  type HookEntries,
  INSTALLED_EVENTS,
  isJevCopsEntry,
  type KnownHooks,
} from "./hook-entries.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `settings.hooks` cannot be merged into (not an object, an event not an array), or null. */
export function hooksShapeError(settings: Readonly<Json>): string | null {
  const hooks = settings.hooks;
  if (hooks === undefined) return null;
  if (!isRecord(hooks)) return "`hooks` is not an object";
  const bad = INSTALLED_EVENTS.find((e) => hooks[e] !== undefined && !Array.isArray(hooks[e]));
  return bad === undefined ? null : `\`hooks.${bad}\` is not an array`;
}

/** `groups` without jev-cops handlers; a group left with none is dropped. */
function stripGroups(groups: readonly unknown[], known?: KnownHooks) {
  let removed = 0;
  const kept = groups.flatMap((g): unknown[] => {
    if (!isRecord(g) || !Array.isArray(g.hooks)) return [g];
    const handlers = g.hooks.filter((h) => !isJevCopsEntry(h, known));
    const n = g.hooks.length - handlers.length;
    removed += n;
    if (n === 0) return [g];
    return handlers.length === 0 ? [] : [{ ...g, hooks: handlers }];
  });
  return { kept, removed };
}

function stripHooks(hooks: Json, dropEmpty: boolean, known?: KnownHooks) {
  let removed = 0;
  const pairs = Object.entries(hooks).flatMap(([event, groups]): [string, unknown][] => {
    if (!Array.isArray(groups)) return [[event, groups]];
    const out = stripGroups(groups, known);
    removed += out.removed;
    if (out.removed === 0) return [[event, groups]];
    return dropEmpty && out.kept.length === 0 ? [] : [[event, out.kept]];
  });
  return { hooks: Object.fromEntries(pairs), removed };
}

/** `settings` with `key` set to `value` in place (or appended), or removed when undefined. */
function withKey(settings: Readonly<Json>, key: string, value: unknown): Json {
  const pairs = Object.entries(settings).filter(([k]) => value !== undefined || k !== key);
  const replaced = pairs.map(([k, v]): [string, unknown] => [k, k === key ? value : v]);
  const present = pairs.some(([k]) => k === key);
  return Object.fromEntries(
    present || value === undefined ? replaced : [...replaced, [key, value]],
  );
}

function strip(settings: Readonly<Json>, dropEmpty: boolean, known?: KnownHooks) {
  if (!isRecord(settings.hooks)) return { settings: settings as Json, removed: 0 };
  const out = stripHooks(settings.hooks, dropEmpty, known);
  if (out.removed === 0) return { settings: settings as Json, removed: 0 };
  const empty = dropEmpty && Object.keys(out.hooks).length === 0;
  return {
    settings: withKey(settings, "hooks", empty ? undefined : out.hooks),
    removed: out.removed,
  };
}

/**
 * Removes every jev-cops handler (uninstall): a group left empty is dropped, and so are an
 * event array and a `hooks` object that only the removal emptied. Returns the input itself
 * when there was nothing to remove.
 */
export function stripJevCops(
  settings: Readonly<Json>,
  known?: KnownHooks,
): { settings: Json; removed: number } {
  return strip(settings, true, known);
}

/**
 * Drops stale jev-cops handlers (another socket, binary, transport, an older layout), then
 * appends `entries`' groups to each event's array, creating what is missing at the end.
 * Everything else is untouched; merging the same entries twice yields the same object
 * (compare the JSON text to detect "already installed"). Throws on a {@link hooksShapeError}.
 */
export function mergeHooks(
  existing: Readonly<Json>,
  entries: HookEntries,
  known?: KnownHooks,
): Json {
  const shape = hooksShapeError(existing);
  if (shape !== null) throw new Error(shape);
  const base = strip(existing, false, known).settings;
  const hooks: Json = isRecord(base.hooks) ? base.hooks : {};
  const added = INSTALLED_EVENTS.map((event): [string, unknown] => {
    const current = hooks[event];
    return [event, [...(Array.isArray(current) ? current : []), ...entries[event]]];
  });
  const addedMap = new Map(added);
  const kept = Object.entries(hooks).map(([k, v]): [string, unknown] => [k, addedMap.get(k) ?? v]);
  const fresh = added.filter(([event]) => !Object.hasOwn(hooks, event));
  return withKey(base, "hooks", Object.fromEntries([...kept, ...fresh]));
}
