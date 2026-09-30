/**
 * Which deny-class policy findings have a deterministic OpenShell construct (spec
 * §Policy compilation 2; PLAN-M2 §2 row 1, §4 table, D-106). OpenShell v0.1.2 is
 * allow-only: "OpenShell denies anything the policy does not allow"
 * (policies/overview.mdx), `filesystem_policy` has only `read_only` and `read_write`
 * ("Paths that are not listed are inaccessible", schema.mdx:48-49), network rules are
 * allow rules for listed binaries ("An empty list matches no binary", schema.mdx:114), and
 * the only deny primitive is `deny_rules` inside an inspected endpoint (schema.mdx:162,
 * :243-246). So the spec's three deny fragments become:
 *
 * | spec fragment | OpenShell construct |
 * |---|---|
 * | host deny | the host is left out of every rule (default deny); judge hosts asserted absent (T13) |
 * | path deny | the path is left unlisted (inaccessible) or listed `read_only` outside every `read_write` root |
 * | binary deny | the binary is left out of a rule's `binaries` (the judge route lists only the hook) |
 * | method/path deny on an allowed host | `deny_rules` on a `rest` + `enforce` endpoint — no starter policy has one |
 */
import { type Verdict, verdictRank } from "@jev-cops/core";

/** The parts of a loaded policy the compiler reads (a `PolicyDefinition` fits). */
export interface PolicyRef {
  readonly name: string;
  readonly version: number;
  readonly range?: readonly [Verdict, Verdict];
}

/** The fragment a policy's deny class compiles to, if any. */
export type FragmentKind = "task-allowlist" | "protection" | "none";

/** One row of the D-106 table. */
export interface FragmentMapping {
  readonly kind: FragmentKind;
  readonly section: "network" | "filesystem" | null;
  readonly why: string;
}

/** The starter policies (D-106). */
export const POLICY_FRAGMENTS: Readonly<Record<string, FragmentMapping>> = Object.freeze({
  "exfil-after-secrets": {
    kind: "task-allowlist",
    section: "network",
    why: "host deny: every host outside the task allowlist is left out (default deny); judge provider hosts asserted absent (T13)",
  },
  "config-tamper": {
    kind: "protection",
    section: "filesystem",
    why: "path deny: harness config read_only outside every read_write root, other config and ~/.jev-cops unlisted",
  },
  "tainted-destructive": {
    kind: "none",
    section: null,
    why: "no kernel equivalent: taint is not visible to the kernel or the proxy",
  },
  "default-branch-guard": {
    kind: "none",
    section: null,
    why: "no kernel equivalent: the pushed branch is inside the git-receive-pack body, not visible at L7; a deny_rules on git-receive-pack would block every push",
  },
  "off-repo-write": {
    kind: "none",
    section: null,
    why: "not deny-class (hold); the workspace read_write limit of the protection set bounds writes anyway",
  },
  "opaque-exec": {
    kind: "none",
    section: null,
    why: "not deny-class (at most hold); an opaque command has no deterministic target",
  },
});

/**
 * The starter set as `policies/` holds it at M2 step 1 (name, version, range): the goldens'
 * input, so a policy version bump does not rewrite them. `cops openshell` loads the real set.
 */
export const STARTER_POLICY_REFS: readonly PolicyRef[] = Object.freeze([
  { name: "config-tamper", version: 2, range: ["annotate", "kill"] },
  { name: "default-branch-guard", version: 2, range: ["hold", "deny"] },
  { name: "exfil-after-secrets", version: 3, range: ["annotate", "kill"] },
  { name: "off-repo-write", version: 2, range: ["hold", "hold"] },
  { name: "opaque-exec", version: 1, range: ["annotate", "hold"] },
  { name: "tainted-destructive", version: 1, range: ["hold", "deny"] },
]);

function denyClass(p: PolicyRef): boolean {
  const top = p.range?.[1] ?? "kill";
  return verdictRank(top) >= verdictRank("deny");
}

/** The D-106 row for `p`; an unknown policy has no fragment (it is judged by the hook only). */
export function policyFragmentsFor(p: PolicyRef): FragmentMapping {
  const known = Object.hasOwn(POLICY_FRAGMENTS, p.name) ? POLICY_FRAGMENTS[p.name] : undefined;
  if (known !== undefined) return known;
  return denyClass(p)
    ? {
        kind: "none",
        section: null,
        why: "no deterministic fragment known: the hook is its only enforcement",
      }
    : { kind: "none", section: null, why: "not deny-class" };
}

/** `name@version`, as `# backs:` comments and the report spell a policy. */
export function policyLabel(p: PolicyRef): string {
  return `${p.name}@${p.version}`;
}
