/**
 * jev-cops's own `--dry-run` (D-108): `openshell policy set` has no dry run (main.rs:2078-2102
 * lists `--policy`, `--global`, `--yes`, `--wait`, `--timeout` only), so the compiled policy
 * is diffed structurally against the sandbox's base policy (`policy get --base --output
 * json`, whose `policy` field mirrors the YAML schema: openshell-policy/src/lib.rs:884-895)
 * or a file. Provider rules (`_provider_*`) belong to providers and are ignored.
 */
import { canonicalJson, canonicalPolicy } from "./emit.ts";
import type { NetworkRule, OpenShellPolicy } from "./schema.ts";

const PROVIDER_PREFIX = "_provider_";
/** Top-level sections compared as a whole besides rules and paths. */
const SECTIONS = ["landlock", "process", "network_middlewares"] as const;

/** Added and removed entries of one list. */
export interface ListDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** What changes between two policies. */
export interface PolicyDiff {
  readonly rules: ListDiff & { readonly changed: readonly string[] };
  readonly readOnly: ListDiff;
  readonly readWrite: ListDiff;
  /** `include_workdir`, `landlock`, `process`, `network_middlewares` when they differ. */
  readonly sections: readonly string[];
  readonly changed: boolean;
}

function listDiff(before: readonly string[], after: readonly string[]): ListDiff {
  return {
    added: after.filter((p) => !before.includes(p)).sort(),
    removed: before.filter((p) => !after.includes(p)).sort(),
  };
}

function ownRules(p: OpenShellPolicy | null): Record<string, NetworkRule> {
  const rules = p === null ? {} : (canonicalPolicy(p).network_policies ?? {});
  return Object.fromEntries(Object.entries(rules).filter(([k]) => !k.startsWith(PROVIDER_PREFIX)));
}

function sectionChanges(before: OpenShellPolicy | null, after: OpenShellPolicy): string[] {
  const workdir = (p: OpenShellPolicy | null) => p?.filesystem_policy?.include_workdir ?? null;
  const differs = SECTIONS.filter(
    (s) => canonicalJson(before?.[s] ?? null) !== canonicalJson(after[s] ?? null),
  );
  return [...(workdir(before) === workdir(after) ? [] : ["include_workdir"]), ...differs];
}

/** The structural diff from `before` (null: nothing yet) to `after`. */
export function diffPolicies(before: OpenShellPolicy | null, after: OpenShellPolicy): PolicyDiff {
  const b = ownRules(before);
  const a = ownRules(after);
  const names = listDiff(Object.keys(b), Object.keys(a));
  const changed = Object.keys(a)
    .filter((k) => k in b && canonicalJson(a[k]) !== canonicalJson(b[k]))
    .sort();
  const fs = (p: OpenShellPolicy | null) => p?.filesystem_policy;
  const readOnly = listDiff(fs(before)?.read_only ?? [], fs(after)?.read_only ?? []);
  const readWrite = listDiff(fs(before)?.read_write ?? [], fs(after)?.read_write ?? []);
  const sections = sectionChanges(before, after);
  const counts = [names.added, names.removed, changed, readOnly.added, readOnly.removed];
  const more = [readWrite.added, readWrite.removed, sections];
  return {
    rules: { ...names, changed },
    readOnly,
    readWrite,
    sections,
    changed: [...counts, ...more].some((l) => l.length > 0),
  };
}

/** One line per change (`+`, `-`, `~`), or `no changes`. */
export function renderDiff(d: PolicyDiff): string[] {
  if (!d.changed) return ["no changes"];
  const fsChanged =
    [d.readOnly, d.readWrite].some((l) => l.added.length + l.removed.length > 0) ||
    d.sections.some((s) => s !== "network_middlewares");
  return [
    ...d.rules.added.map((r) => `+ rule ${r}`),
    ...d.rules.removed.map((r) => `- rule ${r}`),
    ...d.rules.changed.map((r) => `~ rule ${r}`),
    ...d.readOnly.added.map((p) => `+ read_only ${p}`),
    ...d.readOnly.removed.map((p) => `- read_only ${p}`),
    ...d.readWrite.added.map((p) => `+ read_write ${p}`),
    ...d.readWrite.removed.map((p) => `- read_write ${p}`),
    ...d.sections.map((s) => `~ ${s}`),
    ...(fsChanged
      ? [
          "note: filesystem, Landlock and process changes take effect only in a new sandbox (manage-policies.mdx:189-195)",
        ]
      : []),
  ];
}
