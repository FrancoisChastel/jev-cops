/**
 * The task allowlist (spec §Policy compilation 1; PLAN-M2 §4, D-106, D-109): network rules
 * for the package registries of the repo's lockfiles, the git remote and the hosts the task
 * text names, derived by core's `taskAllowlist` so the kernel and the scope feature agree.
 * Every other host is denied by OpenShell's default ("OpenShell denies anything the policy
 * does not allow", policies/overview.mdx) — that omission is `exfil-after-secrets`'s
 * deterministic fragment. Judge provider hosts are dropped wherever they come from (T13).
 *
 * Shapes: registries and task hosts `rest` + `enforce` + `access: read-only` (GET, HEAD,
 * OPTIONS: schema.mdx:238), npm-style registries with `allow_encoded_slash` for scoped
 * packages (network-rules.mdx:316-345); an https remote `read-write` (git's smart-HTTP push
 * is a POST); an ssh remote `protocol: tcp` + `tls: skip` on its port (SSH is not HTTP and
 * the client must complete its own handshake: network-rules.mdx:587-640). Binaries: the
 * agent's executables; tools the agent starts share the rules (network-rules.mdx:71-73).
 */
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG, taskAllowlist } from "@jev-cops/core";
import type { Endpoint, NetworkRule } from "../schema.ts";
import type { Absent, FragmentReport, PolicyUpdate } from "../types.ts";
import { judgeHostReached } from "./judge-hosts.ts";
import { JUDGE_HOST } from "./judge-route.ts";

/** Rule keys. */
export const TASK_RULES = Object.freeze({
  registries: "jev_cops_task_registries",
  remote: "jev_cops_task_remote",
  hosts: "jev_cops_task_hosts",
});

/** The repo's git remote, as `cops openshell` reads it from `.git/config`. */
export interface GitRemote {
  readonly host: string;
  readonly transport: "https" | "ssh";
  readonly port: number;
}

/** What the daemon knows about the repo (core `RepoHints`, plus the remote's transport). */
export interface RepoInput {
  /** Lockfile names or paths at the repo root. */
  readonly lockfiles: readonly string[];
  readonly remote: GitRemote | null;
}

/** What the task allowlist is built from. */
export interface TaskAllowlistInput {
  readonly task: string | null;
  readonly repo: RepoInput | null;
  /** The agent's executables (real paths). */
  readonly binaries: readonly string[];
  /** Hosts no rule may reach (T13). */
  readonly judgeHosts: readonly string[];
  /** Core's registry table and scope settings; default the daemon's defaults. */
  readonly context?: ContextConfig;
}

/** The fragment: up to three rules, the live updates for the task hosts, and its report. */
export interface TaskAllowlistFragment extends FragmentReport {
  readonly rules: Readonly<Record<string, NetworkRule>>;
  readonly updates: readonly PolicyUpdate[];
}

/**
 * Registry hosts per core registry domain (core matches subdomains; OpenShell endpoints
 * are exact hosts). npm and PyPI from network-rules.mdx:278-345; the others are the
 * registries' documented download hosts. A domain not listed is used as the host.
 */
export const REGISTRY_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "npmjs.org": ["registry.npmjs.org"],
  "registry.yarnpkg.com": ["registry.yarnpkg.com"],
  "pypi.org": ["pypi.org", "files.pythonhosted.org"],
  "crates.io": ["crates.io", "index.crates.io", "static.crates.io"],
  "proxy.golang.org": ["proxy.golang.org", "sum.golang.org"],
});
/** Registries whose clients send `%2F` in paths (npm scoped packages). */
const ENCODED_SLASH: ReadonlySet<string> = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const HTTPS_PORT = 443;

interface Candidate {
  readonly host: string;
  readonly port: number;
  readonly source: string;
}

function readOnly(host: string): Endpoint {
  const base: Endpoint = {
    host,
    port: HTTPS_PORT,
    protocol: "rest",
    enforcement: "enforce",
    access: "read-only",
  };
  return ENCODED_SLASH.has(host) ? { ...base, allow_encoded_slash: true } : base;
}

function remoteEndpoint(remote: GitRemote): Endpoint {
  const host = remote.host.toLowerCase();
  if (remote.transport === "ssh") return { host, port: remote.port, protocol: "tcp", tls: "skip" };
  return {
    host,
    port: remote.port,
    protocol: "rest",
    enforcement: "enforce",
    access: "read-write",
  };
}

/** Candidates minus judge hosts, the gateway host and duplicates of earlier candidates. */
function screen(
  candidates: readonly Candidate[],
  judgeHosts: readonly string[],
): { kept: Candidate[]; absent: Absent[] } {
  const kept: Candidate[] = [];
  const absent: Absent[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.host}:${c.port}`;
    const judge = judgeHostReached(c.host, judgeHosts);
    if (judge !== null) {
      const why = `judge provider endpoint ${judge} (T13), ${c.source}: only copsd, on the host, reaches it`;
      if (!absent.some((a) => a.host === c.host)) absent.push({ host: c.host, why });
    } else if (c.host === JUDGE_HOST) {
      absent.push({
        host: c.host,
        why: `${c.source}: the gateway host is reachable only through the judge route`,
      });
    } else if (!seen.has(key)) {
      kept.push(c);
    }
    seen.add(key);
  }
  return { kept, absent };
}

function candidates(input: TaskAllowlistInput): Candidate[] {
  const cfg = input.context ?? DEFAULT_CONTEXT_CONFIG;
  const remote = input.repo?.remote ?? null;
  const lockfiles = [...(input.repo?.lockfiles ?? [])];
  const domains = taskAllowlist(input.task, { lockfiles }, cfg).domains;
  const registries = domains.flatMap((d) => REGISTRY_HOSTS[d] ?? [d]);
  const named = taskAllowlist(input.task, undefined, cfg).hosts;
  const one = (source: string) => (host: string) => ({ host, port: HTTPS_PORT, source });
  return [
    ...(remote === null
      ? []
      : [{ host: remote.host, port: remote.port, source: "the git remote" }]),
    ...registries.map(one("a lockfile registry")),
    ...named.map(one("named in the task")),
  ].map((c) => ({ ...c, host: c.host.toLowerCase() }));
}

/** Builds the task allowlist fragment; see the module comment. */
export function taskAllowlistFragment(input: TaskAllowlistInput): TaskAllowlistFragment {
  const { kept, absent } = screen(candidates(input), input.judgeHosts);
  const binaries = [...input.binaries];
  if (kept.length > 0 && binaries.length === 0) {
    const refusal =
      "the layout names no agent binaries: task allowlist rules would match no binary";
    return { rules: {}, updates: [], absent, gaps: [], refusals: [refusal] };
  }
  const bySource = (s: string) => kept.filter((c) => c.source === s);
  const remote = input.repo?.remote ?? null;
  const remoteKept = remote !== null && bySource("the git remote").length > 0;
  const groups: ReadonlyArray<[string, Endpoint[]]> = [
    [TASK_RULES.remote, remoteKept ? [remoteEndpoint(remote)] : []],
    [TASK_RULES.registries, bySource("a lockfile registry").map((c) => readOnly(c.host))],
    [TASK_RULES.hosts, bySource("named in the task").map((c) => readOnly(c.host))],
  ];
  const withBinaries = binaries.map((path) => ({ path }));
  const rules = Object.fromEntries(
    groups
      .filter(([, endpoints]) => endpoints.length > 0)
      .map(([name, endpoints]) => [name, { endpoints, binaries: withBinaries }]),
  );
  const updates = bySource("named in the task").map((c) => ({
    ruleName: TASK_RULES.hosts,
    addEndpoint: `${c.host}:${HTTPS_PORT}:read-only:rest:enforce`,
    binaries,
  }));
  return { rules, updates, absent, gaps: [], refusals: [] };
}
