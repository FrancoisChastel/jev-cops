import { posix } from "node:path";
import { urlHost } from "../normalizer/net.ts";
import { canonicalTool, isInertTool } from "../normalizer/normalize.ts";
import type { NormalizedEvent } from "../normalizer/types.ts";
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./config.ts";
import type { CaseFile } from "./types.ts";

/** What the daemon knows about the repo without the agent's help (passed in, no FS here). */
export interface RepoHints {
  /** Lockfile paths or basenames present in the repo. */
  lockfiles: string[];
  /** Host of the git remote; the event schema carries none, so it comes from here. */
  remoteHost?: string;
}

/** Hosts the task plausibly needs: `hosts` match exactly, `domains` also match subdomains. */
export interface TaskAllowlist {
  hosts: string[];
  domains: string[];
}

/** Deterministic scope: 0 off task, 1 on task; `unsure` when only soft rules fired. */
export interface ScopeScore {
  value: number;
  unsure: boolean;
  why: string[];
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
/** Extensions that make `name.ext` a file, not a host, even where `ext` is a real TLD. */
const FILE_EXTENSIONS = new Set(
  ["sh", "py", "md", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "yml", "yaml"].concat(
    ["toml", "lock", "txt", "go", "rb", "java", "kt", "c", "h", "cpp", "css", "html", "xml"],
    ["log", "sql", "env", "cfg", "ini", "conf", "lockb", "sum", "mod", "csv", "pem", "key"],
  ),
);
const WRAPPING = /^["'`(<[]+|["'`)>\].,;:!?]+$/g;

function bareHost(word: string): string | null {
  const candidate = (word.split("/")[0] ?? "").toLowerCase();
  if (!HOSTNAME.test(candidate)) return null;
  const tld = candidate.slice(candidate.lastIndexOf(".") + 1);
  return FILE_EXTENSIONS.has(tld) ? null : candidate;
}

function taskHosts(task: string): string[] {
  const words = task.split(/\s+/).map((w) => w.replace(WRAPPING, ""));
  return words.flatMap((w) => {
    if (w.includes("://")) {
      const host = urlHost(w);
      return host === null ? [] : [host];
    }
    if (w.startsWith("/") || w.startsWith(".")) return [];
    const host = bareHost(w);
    return host === null ? [] : [host];
  });
}

function registriesFor(
  task: string,
  lockfiles: ReadonlyArray<string>,
  registries: Readonly<Record<string, ReadonlyArray<string>>>,
): string[] {
  const present = new Set(lockfiles.map((f) => posix.basename(f)));
  const lowerTask = task.toLowerCase();
  return Object.entries(registries)
    .filter(([file]) => present.has(file) || lowerTask.includes(file.toLowerCase()))
    .flatMap(([, hosts]) => hosts);
}

/**
 * Task-derived allowlist (spec §Policy compilation 1): hosts named in the task text
 * (URLs and bare hostnames, file names excluded), the git remote host from `hints`, and
 * the registries of lockfiles present or named in the task. No filesystem access.
 */
export function taskAllowlist(
  task: string | null,
  hints?: RepoHints,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): TaskAllowlist {
  const text = task ?? "";
  const remote = hints?.remoteHost?.toLowerCase();
  const hosts = [...taskHosts(text), ...(remote === undefined ? [] : [remote])];
  const domains = registriesFor(text, hints?.lockfiles ?? [], cfg.scope.registries);
  return { hosts: [...new Set(hosts)], domains: [...new Set(domains)] };
}

/** True when `host` is an allowlisted host, or a registry domain or one of its subdomains. */
export function hostAllowed(host: string, list: TaskAllowlist): boolean {
  const h = host.toLowerCase();
  return list.hosts.includes(h) || list.domains.some((d) => h === d || h.endsWith(`.${d}`));
}

const READ_TOOLS = ["Read", "Grep", "Glob"];

/** Task keyword → tools that task plausibly needs. A small, deliberately loose table. */
export const EXPECTED_TOOLS: ReadonlyArray<{ keywords: RegExp; tools: ReadonlyArray<string> }> =
  Object.freeze([
    {
      keywords:
        /\b(?:tests?|fix(?:es)?|bugs?|flaky|debug|failing|refactor|implement|build|lint)\b/i,
      tools: ["Bash", "Edit", "Write", "MultiEdit", ...READ_TOOLS],
    },
    {
      keywords: /\b(?:docs?|documentation|readme|changelog)\b/i,
      tools: ["Edit", "Write", "WebFetch", ...READ_TOOLS],
    },
    {
      keywords: /\b(?:research|investigate|explain|review|summari[sz]e|analy[sz]e)\b/i,
      tools: ["WebFetch", "WebSearch", ...READ_TOOLS],
    },
    {
      keywords: /\b(?:install|upgrade|update|bump|dependency|dependencies|deps)\b/i,
      tools: ["Bash", "Edit", "WebFetch", ...READ_TOOLS],
    },
    { keywords: /\b(?:deploy|release|publish)\b/i, tools: ["Bash", ...READ_TOOLS] },
  ]);

/** Union of the tools every matching keyword row expects; null when no row matches. */
export function expectedTools(task: string | null): ReadonlySet<string> | null {
  if (task === null) return null;
  const rows = EXPECTED_TOOLS.filter((row) => row.keywords.test(task));
  return rows.length === 0 ? null : new Set(rows.flatMap((row) => row.tools));
}

interface Contribution {
  value: number;
  sure: boolean;
  why: string;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function pathContributions(n: NormalizedEvent, cfg: ContextConfig): Contribution[] {
  const root = n.event.env?.git?.repo ?? n.event.call.cwd;
  const paths = n.commands.flatMap((c) => c.pathRefs.map((r) => r.path));
  const implied = paths.length === 0 && n.kind.startsWith("fs.") ? [n.event.call.cwd] : [];
  return [...new Set([...paths, ...implied])].map((p) => {
    const inside = isUnder(p, root) || cfg.scope.tmpDirs.some((t) => isUnder(p, t));
    return { value: inside ? 1 : 0, sure: true, why: `${inside ? "in" : "outside"} repo: ${p}` };
  });
}

function hostContributions(
  n: NormalizedEvent,
  list: TaskAllowlist,
  cfg: ContextConfig,
): Contribution[] {
  const empty = list.hosts.length === 0 && list.domains.length === 0;
  return n.hosts.map((h) => {
    if (empty) return { value: cfg.scope.noAllowlist, sure: false, why: `no allowlist: ${h}` };
    const ok = hostAllowed(h, list);
    return {
      value: ok ? 1 : 0,
      sure: true,
      why: `${ok ? "allowlisted" : "not allowlisted"}: ${h}`,
    };
  });
}

function softContributions(
  n: NormalizedEvent,
  task: string | null,
  cfg: ContextConfig,
): Contribution[] {
  const out: Contribution[] = [];
  if (n.opaque.length > 0) {
    const reasons = [...new Set(n.opaque.map((o) => o.reason))].join(", ");
    out.push({ value: cfg.scope.opaque, sure: false, why: `opaque: ${reasons}` });
  }
  const tools = expectedTools(task);
  const tool = n.event.call.tool;
  if (tools !== null && !tools.has(canonicalTool(tool, n.event.harness))) {
    out.push({ value: cfg.scope.unexpectedTool, sure: false, why: `tool not expected: ${tool}` });
  }
  return out;
}

const INERT_SCOPE: Readonly<ScopeScore> = Object.freeze({
  value: 1,
  unsure: false,
  why: Object.freeze(["inert tool"]) as string[],
});

/**
 * Deterministic scope (the semantic layer is the judge's): paths under the repo (or cwd
 * without one) and tmp dirs → 1, elsewhere → 0; hosts in the task allowlist → 1, not →
 * 0, no allowlist → 0.5; no targets on an exec → 0.7; opaque parts → 0.7; a tool outside
 * the task's expected set → 0.5. The value is the min; `unsure` when the min comes only
 * from soft rules, which is when the spec lets the judge be asked. An inert tool (task
 * list, plan mode, …) has no side effect and is on task: 1. Tool names are read on the
 * event's own harness (Codex `apply_patch` is an Edit, OpenCode `todowrite` is inert).
 */
export function scopeScore(
  n: NormalizedEvent,
  cf: CaseFile,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
  hints?: RepoHints,
): ScopeScore {
  if (isInertTool(n.event.call.tool, n.event.harness)) {
    return { ...INERT_SCOPE, why: [...INERT_SCOPE.why] };
  }
  const list = taskAllowlist(cf.task, hints, cfg);
  const targets = [...pathContributions(n, cfg), ...hostContributions(n, list, cfg)];
  const none: Contribution[] =
    targets.length === 0 ? [{ value: cfg.scope.noTargets, sure: false, why: "no targets" }] : [];
  const all = [...targets, ...none, ...softContributions(n, cf.task, cfg)];
  const value = Math.min(...all.map((c) => c.value));
  const unsure = all.filter((c) => c.value === value).every((c) => !c.sure);
  const why = all.filter((c) => c.value < 1).map((c) => c.why);
  return { value, unsure, why: why.length > 0 ? why : ["all targets on task"] };
}
