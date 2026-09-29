import { mcpServer } from "../normalizer/normalize.ts";
import type { NormalizedCommand, NormalizedEvent } from "../normalizer/types.ts";
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./config.ts";
import type { CaseFile } from "./types.ts";

/** 0 reversible, 0.5 partly or unknown, 1 irreversible; with the reasons behind the max. */
export interface ReversibilityScore {
  value: number;
  why: string[];
}

interface Finding {
  value: number;
  why: string;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function pathFindings(
  c: NormalizedCommand,
  repo: string | undefined,
  cfg: ContextConfig,
): Finding[] {
  const inRepo = (p: string) => repo !== undefined && isUnder(p, repo);
  const inTmp = (p: string) => cfg.scope.tmpDirs.some((t) => isUnder(p, t));
  return c.pathRefs.flatMap((r): Finding[] => {
    if (r.access === "delete") {
      return inRepo(r.path)
        ? [{ value: 0.5, why: `delete in repo: ${r.path}` }]
        : [{ value: 1, why: `delete outside repo: ${r.path}` }];
    }
    if (r.access === "write" && !inRepo(r.path) && !inTmp(r.path)) {
      return [{ value: 1, why: `write outside repo: ${r.path}` }];
    }
    return [];
  });
}

function netFindings(
  c: NormalizedCommand,
  seen: ReadonlySet<string>,
  cfg: ContextConfig,
): Finding[] {
  if (c.kind !== "net" && c.method === undefined) return [];
  if (c.method !== undefined && cfg.reversibility.netWriteMethods.includes(c.method)) {
    return [{ value: 1, why: `net ${c.method}` }];
  }
  const fresh = c.targets.hosts.filter((h) => !seen.has(h));
  return fresh.length > 0 ? [{ value: 0.5, why: `net to new host: ${fresh.join(", ")}` }] : [];
}

function credentialFindings(c: NormalizedCommand, cfg: ContextConfig): Finding[] {
  if (c.kind !== "spawn") return [];
  const credential = new RegExp(cfg.reversibility.credentialName, "i");
  const argNames = c.argv.map((a) => ASSIGNMENT.exec(a)?.[1]).filter((n) => n !== undefined);
  const names = [...Object.keys(c.env), ...argNames].filter((n) => credential.test(n));
  return names.length > 0 ? [{ value: 1, why: `spawn with credential: ${names.join(", ")}` }] : [];
}

function commandFindings(
  c: NormalizedCommand,
  n: NormalizedEvent,
  seen: ReadonlySet<string>,
  cfg: ContextConfig,
): Finding[] {
  const verbs = c.verbs.filter((v) => cfg.reversibility.irreversibleVerbs.includes(v));
  const verbFinding =
    verbs.length > 0 ? [{ value: 1, why: `irreversible verb: ${verbs.join(", ")}` }] : [];
  return [
    ...verbFinding,
    ...pathFindings(c, n.event.env?.git?.repo, cfg),
    ...netFindings(c, seen, cfg),
    ...credentialFindings(c, cfg),
  ];
}

/** Hosts first contacted by another call; the judged call's own record never counts. */
export function hostsSeenByOthers(n: NormalizedEvent, cf: CaseFile): Set<string> {
  const callId = n.event.call.id;
  const seen = [...cf.hostsFirstSeen()].filter(([, s]) => s.callId !== callId);
  return new Set(seen.map(([host]) => host));
}

/**
 * Can this be undone? 1: delete outside the repo, a force/hard/irreversible/privilege
 * verb, a net write (POST/PUT/DELETE/PATCH or an unknown method), a write outside the
 * repo and tmp, a spawn handed a credential. 0.5: delete inside the repo, a GET to a
 * new host, anything opaque (including tools the normalizer cannot read and MCP tools,
 * whose effect is the server's). 0 otherwise.
 * Uses `pathRefs.access`, `verbs` and `method` only. Assumption: git tracking cannot be
 * known without the filesystem, so a write under `env.git.repo` counts as reversible;
 * with no repo known, writes outside tmp count as irreversible.
 */
export function reversibilityScore(
  n: NormalizedEvent,
  cf: CaseFile,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): ReversibilityScore {
  const seen = hostsSeenByOthers(n, cf);
  const unread = n.commands.length === 0 || mcpServer(n.event.call.tool) !== null;
  const opaque: Finding[] =
    n.opaque.length > 0 || unread ? [{ value: 0.5, why: "opaque exec" }] : [];
  const findings = [...n.commands.flatMap((c) => commandFindings(c, n, seen, cfg)), ...opaque];
  const value = findings.reduce((max, f) => Math.max(max, f.value), 0);
  const why = findings.filter((f) => f.value === value && value > 0).map((f) => f.why);
  return { value, why: [...new Set(why)] };
}
