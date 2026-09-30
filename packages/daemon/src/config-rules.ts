import { DEFAULT_CONTEXT_CONFIG, DEFAULT_POLICY_CONFIG } from "@jev-cops/core";

/** A plain JSON-ish table as TOML produces it. */
export type Table = Readonly<Record<string, unknown>>;

/** One leaf of a table: its dotted path segments and value (arrays are leaves). */
export interface Leaf {
  readonly path: readonly string[];
  readonly value: unknown;
}

/** True for `{…}` literals (TOML tables), false for arrays, dates and null. */
export function isTable(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** Every leaf of `table`, depth first, in key order. */
export function leaves(table: Table, prefix: readonly string[] = []): Leaf[] {
  return Object.entries(table).flatMap(([key, value]) =>
    isTable(value) ? leaves(value, [...prefix, key]) : [{ path: [...prefix, key], value }],
  );
}

/** The value at `path`, or undefined. */
export function getIn(table: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (isTable(node) ? node[key] : undefined), table);
}

/** A new table with `value` at `path`; `table` is untouched. */
export function setIn(table: Table, path: readonly string[], value: unknown): Table {
  const [head, ...rest] = path;
  if (head === undefined) return table;
  const child = isTable(table[head]) ? (table[head] as Table) : {};
  return { ...table, [head]: rest.length === 0 ? value : setIn(child, rest, value) };
}

/** Rebuilds a table from leaves. */
export function fromLeaves(list: readonly Leaf[]): Table {
  return list.reduce<Table>((acc, l) => setIn(acc, l.path, l.value), {});
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Leaves a repo override may change, and the direction that tightens. Everything else
 * (judge provider/model, the agent and admin sockets, audit, store, policies dir, other
 * thresholds) is not a tightening a repo can be trusted to make, so it is rejected.
 */
const LOWER_IS_TIGHTER = new Set([
  "policy.bands.annotate",
  "policy.bands.hold",
  "policy.bands.deny",
  "policy.maxAnswerLowering",
  "policy.precedent.maxRiskDelta",
  "context.budget.limit",
  "context.budget.raiseAt",
  "context.budget.holdAt",
]);

/**
 * Switches a repo may only turn on (D-103, D-104): signed checkpoints and fail-closed
 * forwarding. Every other `[audit]` key (paths, keys, target, interval) is the user's.
 */
const TRUE_IS_TIGHTER = new Set(["audit.require_signing", "audit.forward.required"]);

function tightens(dotted: string, value: unknown, base: unknown): boolean {
  if (dotted === "enforcement.mode") return value === "enforce";
  if (TRUE_IS_TIGHTER.has(dotted)) return value === true;
  if (!LOWER_IS_TIGHTER.has(dotted)) return false;
  return typeof value === "number" && typeof base === "number" && value <= base;
}

/** The core defaults under the file sections they configure. */
const CORE_DEFAULTS: Table = { context: DEFAULT_CONTEXT_CONFIG, policy: DEFAULT_POLICY_CONFIG };

/**
 * Splits a repo override into the leaves that keep or tighten `base` and one line per
 * leaf that would loosen it or is not a repo's to set. A leaf equal to the base is kept.
 */
export function tightenOnly(
  repo: Table,
  base: Table,
  source: string,
): { kept: Table; rejected: string[] } {
  const kept: Leaf[] = [];
  const rejected: string[] = [];
  for (const leaf of leaves(repo)) {
    const dotted = leaf.path.join(".");
    const current = getIn(base, leaf.path) ?? getIn(CORE_DEFAULTS, leaf.path);
    if (sameValue(leaf.value, current) || tightens(dotted, leaf.value, current)) kept.push(leaf);
    else rejected.push(`${dotted}: a repo override (${source}) can only tighten; ignored`);
  }
  return { kept: fromLeaves(kept), rejected };
}

/** Core config objects whose keys are free-form (records), not a fixed shape. */
const OPEN_RECORDS = new Set(["environment.hostClasses", "scope.registries"]);

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (isTable(value)) return "table";
  return typeof value;
}

function shapeProblems(patch: Table, shape: unknown, prefix: string[]): string[] {
  return Object.entries(patch).flatMap(([key, value]) => {
    const path = [...prefix, key];
    const dotted = path.join(".");
    if (OPEN_RECORDS.has(prefix.join("."))) return [];
    if (!isTable(shape) || !Object.hasOwn(shape, key)) return [`${dotted}: unknown key`];
    const expected = kindOf(shape[key]);
    if (expected === "table" && isTable(value)) return shapeProblems(value, shape[key], path);
    return kindOf(value) === expected ? [] : [`${dotted}: expected ${expected}`];
  });
}

/**
 * Problems of a `[context]` or `[policy]` partial checked against the core defaults'
 * shape: every key must exist there with the same kind (number, string, array, table).
 * Paths are prefixed with the section name.
 */
export function coreShapeProblems(section: "context" | "policy", patch: Table): string[] {
  const shape = section === "context" ? DEFAULT_CONTEXT_CONFIG : DEFAULT_POLICY_CONFIG;
  return shapeProblems(patch, shape, []).map((p) => `${section}.${p}`);
}
