/**
 * Deterministic YAML for an OpenShell policy: the same policy always gives the same bytes,
 * whatever the insertion order of its keys or list entries. Keys follow the order of
 * docs/how-it-works/policies/schema.mdx (top level :26-33, filesystem :41-45, endpoint
 * :125-175, rules :262-266); rule names and other maps are sorted; every list the schema
 * treats as a set (paths, binaries, endpoints, rules, ports, allowed_ips) is sorted and
 * deduplicated ({@link canonicalPolicy}); strings are double-quoted, numbers and booleans
 * bare, indentation two spaces. A header names the jev-cops version and the hash of the
 * compiler's inputs; `# backs:` comments name the policies a section or rule stands for.
 */
import { createHash } from "node:crypto";
import type { Endpoint, NetworkRule, OpenShellPolicy } from "./schema.ts";

/** What the header and comments say. */
export interface EmitMeta {
  /** The jev-cops version that compiled the policy. */
  readonly version: string;
  /** {@link inputsHash} of the compiler's inputs. */
  readonly inputsHash: string;
  /** `# backs:` lines, keyed by `filesystem_policy`, `landlock`, … or `network_policies.<rule>`. */
  readonly backs?: Readonly<Record<string, readonly string[]>>;
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

const KEY_ORDER: readonly string[] = [
  "version",
  "filesystem_policy",
  "landlock",
  "process",
  "network_policies",
  "network_middlewares",
  "include_workdir",
  "read_only",
  "read_write",
  "compatibility",
  "run_as_user",
  "run_as_group",
  "name",
  "middleware",
  "endpoints",
  "binaries",
  "host",
  "port",
  "ports",
  "method",
  "path",
  "allowed_ips",
  "protocol",
  "tls",
  "enforcement",
  "access",
  "rules",
  "deny_rules",
  "allow_encoded_slash",
  "allow",
  "query",
  "operation_type",
  "operation_name",
  "fields",
  "tool",
  "params",
  "any",
];
/** Maps of named entries: their own keys sorted, the entries' fields in {@link KEY_ORDER}. */
const NAME_MAPS: ReadonlySet<string> = new Set(["network_policies", "network_middlewares"]);
/** Free-form maps: keys sorted alphabetically all the way down. */
const DEEP_MAPS: ReadonlySet<string> = new Set([
  "query",
  "params",
  "config",
  "graphql_persisted_queries",
]);
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `value` as JSON with object keys sorted at every depth; `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries);
  });
}

/** SHA-256 (hex) of {@link canonicalJson}: the `# inputs:` line of the header. */
export function inputsHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function uniqueSorted<T>(items: readonly T[] | undefined, key: (t: T) => string): T[] | undefined {
  if (items === undefined) return undefined;
  const byKey = new Map(items.map((t) => [key(t), t]));
  return [...byKey.keys()].sort().map((k) => byKey.get(k) as T);
}

function canonicalEndpoint(e: Endpoint): Endpoint {
  const sorted = {
    ...e,
    ports: uniqueSorted(e.ports, (p) => String(p).padStart(5, "0"))?.map(Number),
    allowed_ips: uniqueSorted(e.allowed_ips, String),
    rules: uniqueSorted(e.rules, canonicalJson),
    deny_rules: uniqueSorted(e.deny_rules, canonicalJson),
  };
  return Object.fromEntries(Object.entries(sorted).filter(([, v]) => v !== undefined)) as Endpoint;
}

/** Endpoints sort by host, then ports, then path selector, then everything else. */
function endpointKey(e: Endpoint): string {
  const ports = (e.ports ?? (e.port === undefined ? [] : [e.port])).map((p) =>
    String(p).padStart(5, "0"),
  );
  return [e.host ?? "", ports.join(","), e.path ?? "", canonicalJson(e)].join("\u0000");
}

function canonicalRule(rule: NetworkRule): NetworkRule {
  const endpoints = rule.endpoints?.map(canonicalEndpoint);
  const sorted = {
    ...rule,
    endpoints: uniqueSorted(endpoints, endpointKey),
    binaries: uniqueSorted(rule.binaries, (b) => b.path),
  };
  return Object.fromEntries(
    Object.entries(sorted).filter(([, v]) => v !== undefined),
  ) as NetworkRule;
}

/** A copy of `policy` with every set-like list sorted and deduplicated. */
export function canonicalPolicy(policy: OpenShellPolicy): OpenShellPolicy {
  const fs = policy.filesystem_policy;
  const rules = policy.network_policies;
  return {
    ...policy,
    ...(fs === undefined
      ? {}
      : {
          filesystem_policy: Object.fromEntries(
            Object.entries({
              ...fs,
              read_only: uniqueSorted(fs.read_only, String),
              read_write: uniqueSorted(fs.read_write, String),
            }).filter(([, v]) => v !== undefined),
          ),
        }),
    ...(rules === undefined
      ? {}
      : {
          network_policies: Object.fromEntries(
            Object.entries(rules).map(([k, r]) => [k, canonicalRule(r)]),
          ),
        }),
  };
}

function orderKeys(keys: readonly string[], alphabetical: boolean): string[] {
  const rank = (k: string) => {
    const i = alphabetical ? -1 : KEY_ORDER.indexOf(k);
    return i === -1 ? KEY_ORDER.length : i;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function scalar(v: string | number | boolean | null): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function keyText(k: string): string {
  return PLAIN_KEY.test(k) ? k : JSON.stringify(k);
}

interface Ctx {
  readonly path: string;
  /** Inside a free-form map: every key sorted. */
  readonly deep: boolean;
  /** This object is a map of named entries: its own keys sorted. */
  readonly named: boolean;
  readonly backs: Readonly<Record<string, readonly string[]>>;
}

function childCtx(ctx: Ctx, key: string): Ctx {
  const path = ctx.path === "" ? key : `${ctx.path}.${key}`;
  return { ...ctx, path, deep: ctx.deep || DEEP_MAPS.has(key), named: NAME_MAPS.has(key) };
}

function arrayLines(items: readonly Json[], indent: number, ctx: Ctx): string[] {
  const pad = " ".repeat(indent);
  return items.flatMap((item) => {
    if (item === null || typeof item !== "object") return [`${pad}- ${scalar(item)}`];
    const inner = valueLines(item, indent + 2, { ...ctx, path: `${ctx.path}[]`, named: false });
    const [first = "", ...rest] = inner;
    return [`${pad}- ${first.slice(indent + 2)}`, ...rest];
  });
}

function objectLines(value: { readonly [k: string]: Json }, indent: number, ctx: Ctx): string[] {
  const pad = " ".repeat(indent);
  return orderKeys(Object.keys(value), ctx.deep || ctx.named).flatMap((k) => {
    const v = value[k] as Json;
    const child = childCtx(ctx, k);
    const backs = ctx.backs[child.path];
    const comment = backs === undefined ? [] : [`${pad}# backs: ${backs.join(", ")}`];
    const head = `${pad}${keyText(k)}:`;
    if (v === null || typeof v !== "object") return [...comment, `${head} ${scalar(v)}`];
    if (Array.isArray(v) && v.length === 0) return [...comment, `${head} []`];
    if (!Array.isArray(v) && Object.keys(v).length === 0) return [...comment, `${head} {}`];
    return [...comment, head, ...valueLines(v, indent + 2, child)];
  });
}

function valueLines(value: Json, indent: number, ctx: Ctx): string[] {
  if (Array.isArray(value)) return arrayLines(value, indent, ctx);
  if (value !== null && typeof value === "object") {
    return objectLines(value as { readonly [k: string]: Json }, indent, ctx);
  }
  return [`${" ".repeat(indent)}${scalar(value as string | number | boolean | null)}`];
}

/** The policy as YAML: header, then each top-level section separated by a blank line. */
export function emitPolicy(policy: OpenShellPolicy, meta: EmitMeta): string {
  const canon = JSON.parse(JSON.stringify(canonicalPolicy(policy))) as Record<string, Json>;
  const ctx: Ctx = { path: "", deep: false, named: false, backs: meta.backs ?? {} };
  const sections = orderKeys(Object.keys(canon), false).map((k) =>
    objectLines({ [k]: canon[k] as Json }, 0, ctx).join("\n"),
  );
  const header = [
    `# Generated by jev-cops ${meta.version} (cops openshell compile); do not edit by hand.`,
    "# OpenShell sandbox policy, schema version 1 (checked against OpenShell v0.1.2).",
    `# inputs: sha256:${meta.inputsHash}`,
  ];
  return `${header.join("\n")}\n\n${sections.join("\n\n")}\n`;
}
