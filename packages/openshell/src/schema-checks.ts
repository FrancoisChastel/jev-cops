/**
 * The cross-field rules of the OpenShell policy schema (docs/how-it-works/policies/
 * schema.mdx at `main` 7caff12, cited as `schema.mdx:<line>`), run after the shapes of
 * schema.ts parse. Each returns plain messages naming where the problem is.
 */
import { hostMatches, hostPatternProblem, hostsOverlap } from "./hosts.ts";
import type { Endpoint, Matcher, Middleware, OpenShellPolicy } from "./schema.ts";

const MAX_PATHS = 256;
const MAX_MIDDLEWARES = 10;
const MAX_SELECTOR_PATTERNS = 32;
const PROVIDER_PREFIX = "_provider_";
/** Protocols whose requests OpenShell inspects (schema.mdx:157). */
const REQUEST_PROTOCOLS: ReadonlySet<string> = new Set([
  "rest",
  "websocket",
  "graphql",
  "mcp",
  "json-rpc",
]);
/** Fields a `protocol: tcp` endpoint must not set (schema.mdx:220-222). */
const REQUEST_FIELDS: readonly (keyof Endpoint)[] = [
  "path",
  "enforcement",
  "access",
  "rules",
  "deny_rules",
  "request_body_credential_rewrite",
  "websocket_credential_rewrite",
  "credential_signing",
  "signing_service",
  "signing_region",
  "persisted_queries",
  "graphql_persisted_queries",
  "graphql_max_body_bytes",
  "mcp",
  "json_rpc",
];

interface Located {
  readonly where: string;
  readonly endpoint: Endpoint;
}

function pathCount(policy: OpenShellPolicy): string[] {
  const fs = policy.filesystem_policy;
  const count = (fs?.read_only?.length ?? 0) + (fs?.read_write?.length ?? 0);
  return count > MAX_PATHS ? [`filesystem_policy lists ${count} paths; at most ${MAX_PATHS}`] : [];
}

function destinationProblems(e: Endpoint): string[] {
  const out: string[] = [];
  const hasPort = e.port !== undefined;
  const hasPorts = e.ports !== undefined;
  if (hasPort && hasPorts) out.push("set `port` or `ports`, not both");
  if (!hasPort && !hasPorts) out.push("an endpoint needs `port` or `ports`");
  if (e.host === undefined && (e.allowed_ips ?? []).length === 0) {
    out.push("an endpoint can omit `host` only when it sets `allowed_ips`");
  }
  const shape = e.host === undefined ? null : hostPatternProblem(e.host);
  if (shape !== null) out.push(shape);
  return out;
}

function tcpProblems(e: Endpoint): string[] {
  if (e.protocol !== "tcp") return [];
  const out = e.host === undefined ? ["protocol tcp requires a hostname and a port"] : [];
  const set = REQUEST_FIELDS.filter((f) => e[f] !== undefined);
  return [...out, ...set.map((f) => `protocol tcp accepts no request field: ${f}`)];
}

function inspectionProblems(e: Endpoint): string[] {
  const p = e.protocol;
  const out: string[] = [];
  if (e.tls === "skip" && p !== undefined && REQUEST_PROTOCOLS.has(p)) {
    out.push(`tls: skip cannot be used with protocol ${p}`);
  }
  if (e.access !== undefined && e.rules !== undefined)
    out.push("access and rules cannot be combined");
  const rpc = p === "mcp" || p === "json-rpc";
  if (rpc && e.access !== undefined) out.push(`access presets do not apply to protocol ${p}`);
  if ((p === "rest" || p === "websocket" || p === "graphql") && !e.access && !e.rules) {
    out.push(`a ${p} endpoint needs access or rules`);
  }
  const allowAll = e.mcp?.allow_all_known_mcp_methods === true;
  if (rpc && e.rules === undefined && !(p === "mcp" && allowAll)) {
    out.push(`a ${p} endpoint needs rules`);
  }
  if (e.mcp !== undefined && p !== "mcp") out.push("mcp options are allowed only on mcp endpoints");
  return out;
}

function denyProblems(e: Endpoint): string[] {
  if (e.deny_rules === undefined) return [];
  if (e.protocol === undefined) return ["deny_rules require protocol"];
  if (e.protocol !== "mcp" && e.rules === undefined && e.access === undefined) {
    return ["deny_rules require rules or access"];
  }
  return [];
}

/** Required matcher fields per protocol (schema.mdx:262-519). */
function matcherProblems(e: Endpoint): string[] {
  const all: Matcher[] = [...(e.rules ?? []).map((r) => r.allow), ...(e.deny_rules ?? [])];
  const allowAll = e.mcp?.allow_all_known_mcp_methods === true;
  return all.flatMap((m) => {
    switch (e.protocol) {
      case "rest":
      case "websocket":
        return m.method && m.path ? [] : [`a ${e.protocol} rule needs method and path`];
      case "graphql":
        return m.operation_type ? [] : ["a graphql rule needs operation_type"];
      case "json-rpc":
        return m.method ? [] : ["a json-rpc rule needs method"];
      case "mcp":
        return m.method || allowAll ? [] : ["an mcp rule needs method"];
      default:
        return [];
    }
  });
}

function endpointProblems(e: Endpoint): string[] {
  return [
    ...destinationProblems(e),
    ...tcpProblems(e),
    ...inspectionProblems(e),
    ...denyProblems(e),
    ...matcherProblems(e),
  ];
}

function located(policy: OpenShellPolicy): Located[] {
  return Object.entries(policy.network_policies ?? {}).flatMap(([key, rule]) =>
    (rule.endpoints ?? []).map((endpoint, i) => ({
      where: `network_policies.${key}.endpoints[${i}]`,
      endpoint,
    })),
  );
}

function portsOf(e: Endpoint): number[] {
  return e.ports ?? (e.port === undefined ? [] : [e.port]);
}

function sharePort(a: Endpoint, b: Endpoint): boolean {
  if (a.host === undefined || b.host === undefined) return false;
  const pb = portsOf(b);
  return portsOf(a).some((p) => pb.includes(p)) && hostsOverlap(a.host, b.host);
}

function sameText(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
}

function credentialKey(e: Endpoint): string {
  return JSON.stringify([
    e.credential_binding?.provider ?? null,
    e.request_body_credential_rewrite ?? false,
    e.websocket_credential_rewrite ?? false,
  ]);
}

/** Endpoints that can match one name on one port must agree (schema.mdx:223-226). */
function pairProblem(x: Located, y: Located): string | null {
  const [a, b] = [x.endpoint, y.endpoint];
  if (!sharePort(a, b)) return null;
  const pair = `${x.where} and ${y.where}`;
  if (a.tls !== b.tls || !sameText(a.allowed_ips, b.allowed_ips)) {
    return `${pair} can match the same host and port and must use the same tls and allowed_ips`;
  }
  const inspected = (e: Endpoint) => e.protocol !== undefined && REQUEST_PROTOCOLS.has(e.protocol);
  if (!inspected(a) || !inspected(b) || (a.path ?? "") !== (b.path ?? "")) return null;
  const agree =
    a.protocol === b.protocol &&
    (a.enforcement ?? "audit") === (b.enforcement ?? "audit") &&
    credentialKey(a) === credentialKey(b);
  return agree ? null : `${pair} must agree on protocol, enforcement and credential settings`;
}

function overlapProblems(all: readonly Located[]): string[] {
  return all.flatMap((x, i) =>
    all.slice(i + 1).flatMap((y) => {
      const problem = pairProblem(x, y);
      return problem === null ? [] : [problem];
    }),
  );
}

function selects(m: Middleware, host: string): boolean {
  const excluded = (m.endpoints.exclude ?? []).some((p) => hostMatches(p, host));
  return !excluded && m.endpoints.include.some((p) => hostsOverlap(p, host));
}

/** At most 10 configurations, unique `order`, ≤ 32 patterns, fail_closed never on tls: skip. */
function middlewareProblems(policy: OpenShellPolicy, all: readonly Located[]): string[] {
  const entries = Object.entries(policy.network_middlewares ?? {});
  const out: string[] = [];
  if (entries.length > MAX_MIDDLEWARES) out.push(`at most ${MAX_MIDDLEWARES} network_middlewares`);
  const orders = entries.map(([, m]) => m.order ?? 0);
  if (new Set(orders).size !== orders.length)
    out.push("network_middlewares order values must be unique");
  for (const [key, m] of entries) {
    const patterns = m.endpoints.include.length + (m.endpoints.exclude?.length ?? 0);
    if (patterns > MAX_SELECTOR_PATTERNS)
      out.push(`network_middlewares.${key}: at most 32 patterns`);
    if ((m.on_error ?? "fail_closed") !== "fail_closed") continue;
    const skipped = all.filter((l) => l.endpoint.tls === "skip" && l.endpoint.host !== undefined);
    for (const l of skipped) {
      if (selects(m, l.endpoint.host ?? "")) {
        out.push(
          `network_middlewares.${key} is fail_closed and selects ${l.where}, which sets tls: skip`,
        );
      }
    }
  }
  return out;
}

/** Every documented cross-field rule the shapes cannot express. */
export function policyProblems(policy: OpenShellPolicy): string[] {
  const all = located(policy);
  const reserved = Object.keys(policy.network_policies ?? {})
    .filter((k) => k.startsWith(PROVIDER_PREFIX))
    .map((k) => `network_policies.${k}: rule keys cannot start with ${PROVIDER_PREFIX}`);
  return [
    ...pathCount(policy),
    ...reserved,
    ...all.flatMap((l) => endpointProblems(l.endpoint).map((m) => `${l.where}: ${m}`)),
    ...overlapProblems(all),
    ...middlewareProblems(policy, all),
  ];
}
