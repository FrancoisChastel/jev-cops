/**
 * `cops doctor`, daemon side (PLAN-M1 §4.4): `GET /v1/health` on the agent socket and on
 * the admin socket (version, policies and their degraded flags, judge, enforcement,
 * protected paths), and the audit log's hash chain through the daemon's own verifier
 * (T12), with the L6 caveat printed every time.
 */
import { existsSync } from "node:fs";
import { verifyChain } from "@jev-cops/daemon";
import { z } from "zod";
import { CLI_VERSION } from "../version.ts";
import { type Check, check } from "./doctor-types.ts";

const GROUP = "copsd";
const HEALTH_TIMEOUT_MS = 2_000;

/**
 * What local verification of the audit chain cannot see (gate review L6): the chain is
 * unkeyed SHA-256, so a cut tail or a recomputed file still verifies.
 */
export const AUDIT_CAVEAT =
  "Local verification detects mid-file edits and deletions, not tail truncation or a full recompute (L6); only the off-box copy (M2) catches those.";

const healthSchema = z.object({
  version: z.string(),
  policies: z.array(
    z.object({ name: z.string(), version: z.number(), degraded: z.boolean().optional() }),
  ),
  judge: z.string(),
  enforcement: z.enum(["observe", "enforce"]),
  sockets: z.object({ agent: z.string(), admin: z.string() }),
  protected_paths: z.number(),
  latched_sessions: z.number(),
});

/** The daemon's `/v1/health` body, as far as the doctor reads it. */
export type Health = z.infer<typeof healthSchema>;

/** A health request's outcome. */
export type HealthReply =
  | { readonly ok: true; readonly health: Health }
  | { readonly ok: false; readonly error: string };

/** Both sockets probed. */
export interface DaemonProbe {
  readonly socket: string;
  readonly adminSocket: string;
  readonly agent: HealthReply;
  readonly admin: HealthReply;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `GET /v1/health` on the Unix socket `socket`; never throws. */
export async function fetchHealth(
  socket: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<HealthReply> {
  try {
    const res = await fetch("http://localhost/v1/health", {
      unix: socket,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = healthSchema.safeParse(await res.json().catch(() => null));
    if (res.status === 200 && parsed.success) return { ok: true, health: parsed.data };
    return { ok: false, error: `HTTP ${res.status}: not a copsd health reply` };
  } catch (cause) {
    return { ok: false, error: message(cause) };
  }
}

/** Probes the agent socket and the admin socket together. */
export async function probeDaemon(socket: string, adminSocket: string): Promise<DaemonProbe> {
  const [agent, admin] = await Promise.all([fetchHealth(socket), fetchHealth(adminSocket)]);
  return { socket, adminSocket, agent, admin };
}

/** The health of whichever socket answered (the agent's first), or null. */
function healthOf(p: DaemonProbe): Health | null {
  if (p.agent.ok) return p.agent.health;
  return p.admin.ok ? p.admin.health : null;
}

/** The daemon's enforcement mode, or null when neither socket answered. */
export function enforcementOf(p: DaemonProbe): "observe" | "enforce" | null {
  return healthOf(p)?.enforcement ?? null;
}

function agentCheck(p: DaemonProbe): Check {
  if (p.agent.ok) {
    return check(
      GROUP,
      "agent socket",
      "ok",
      `copsd ${p.agent.health.version} answers on ${p.socket}`,
    );
  }
  return check(
    GROUP,
    "agent socket",
    "fail",
    `copsd is not reachable on ${p.socket} (${p.agent.error}): start copsd (or pass --socket/--config). While it is down the Claude Code hook blocks every call but reads (fail closed) and Pi blocks every tool but read-only ones.`,
  );
}

function adminCheck(p: DaemonProbe): Check {
  if (p.adminSocket === p.socket) {
    return check(
      GROUP,
      "admin socket",
      "warn",
      `${p.adminSocket} is the agent socket: they must differ (D-060), and the admin socket must never be mounted into a sandbox`,
    );
  }
  if (!p.admin.ok) {
    return check(
      GROUP,
      "admin socket",
      "warn",
      `not reachable on ${p.adminSocket} (${p.admin.error}): budget reset and full explain are unavailable`,
    );
  }
  const theirs = p.agent.ok ? p.agent.health.sockets.admin : p.adminSocket;
  if (theirs !== p.adminSocket) {
    return check(
      GROUP,
      "admin socket",
      "warn",
      `${p.adminSocket} answers, but the daemon on ${p.socket} serves its admin routes on ${theirs}`,
    );
  }
  return check(
    GROUP,
    "admin socket",
    "ok",
    `answers on ${p.adminSocket} (human only: never mount it into a sandbox)`,
  );
}

function policiesCheck(h: Health): Check {
  if (h.policies.length === 0) {
    return check(
      GROUP,
      "policies",
      "fail",
      "no policy is loaded: only the risk floor decides, and nothing kills a config write",
    );
  }
  const keys = h.policies.map((p) => `${p.name}@${p.version}`);
  const degraded = h.policies
    .filter((p) => p.degraded === true)
    .map((p) => `${p.name}@${p.version}`);
  const problems = [
    ...(degraded.length > 0
      ? [`degraded: ${degraded.join(", ")} (a \`when\` overran its budget)`]
      : []),
    ...(h.policies.some((p) => p.name === "config-tamper")
      ? []
      : ["config-tamper is not loaded: writes to harness and jev-cops config are not killed (T1)"]),
  ];
  const listed = `${keys.length} loaded: ${keys.join(", ")}`;
  if (problems.length === 0) return check(GROUP, "policies", "ok", listed);
  return check(GROUP, "policies", "warn", `${listed}; ${problems.join("; ")}`);
}

function versionCheck(h: Health): Check {
  if (h.version === CLI_VERSION) {
    return check(GROUP, "version", "ok", `copsd ${h.version} = cops ${CLI_VERSION}`);
  }
  const detail = `copsd ${h.version}, cops ${CLI_VERSION}: rebuild or reinstall so both come from one release`;
  return check(GROUP, "version", "warn", detail);
}

function judgeCheck(h: Health): Check {
  if (h.judge !== "disabled" && h.judge !== "off") return check(GROUP, "judge", "ok", h.judge);
  const detail = `${h.judge}: the semantic judge is off; the deterministic floor and the policies decide alone`;
  return check(GROUP, "judge", "warn", detail);
}

function enforcementCheck(h: Health): Check {
  if (h.enforcement === "enforce") return check(GROUP, "enforcement", "ok", "enforce");
  const detail =
    'observe: no verdict is enforced; every call is allowed and logged with what jev-cops would have done (set [enforcement] mode = "enforce")';
  return check(GROUP, "enforcement", "warn", detail);
}

function protectedCheck(h: Health): Check {
  if (h.protected_paths > 0) {
    const detail = `${h.protected_paths} paths config-tamper guards beyond the harness dirs (the judge's own inputs)`;
    return check(GROUP, "protected paths", "ok", detail);
  }
  const detail = "0: the daemon's own config, policies, audit log and sockets are not protected";
  return check(GROUP, "protected paths", "warn", detail);
}

function factChecks(h: Health): Check[] {
  const latched = `${h.latched_sessions} root session(s) latched killed (cleared only through the admin socket)`;
  return [
    versionCheck(h),
    policiesCheck(h),
    judgeCheck(h),
    enforcementCheck(h),
    protectedCheck(h),
    check(GROUP, "latched sessions", "ok", latched),
  ];
}

/** The daemon checks from a probe of both sockets. */
export function daemonChecks(p: DaemonProbe): Check[] {
  const health = healthOf(p);
  return [agentCheck(p), adminCheck(p), ...(health === null ? [] : factChecks(health))];
}

/** The audit chain check for the log at `path` (T12), the L6 caveat included. */
export function auditChecks(path: string): Check[] {
  if (!existsSync(path)) {
    return [
      check(
        "audit",
        "chain",
        "warn",
        `no audit log at ${path} (copsd not started with this config?). ${AUDIT_CAVEAT}`,
      ),
    ];
  }
  const report = verifyChain(path);
  if (report.ok) {
    return [
      check(
        "audit",
        "chain",
        "ok",
        `${report.lines} line${report.lines === 1 ? "" : "s"} verify at ${path}. ${AUDIT_CAVEAT}`,
      ),
    ];
  }
  return [
    check(
      "audit",
      "chain",
      "fail",
      `broken at seq ${report.brokenAt} of ${path} (${report.reason}): the log was edited or lines were deleted (T12); keep the file for review. ${AUDIT_CAVEAT}`,
    ),
  ];
}
