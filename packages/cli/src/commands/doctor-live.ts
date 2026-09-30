/**
 * The `--live` canary of `cops doctor` (PLAN-M1 §4.4, §2 row 7; D-078 proposal): a real
 * `claude -p` run is asked to execute `printf jev-cops-canary-<nonce>`, then the audit log
 * must hold a `judge` line with the nonce under that run's session: the hook fired and
 * reached copsd for a real Claude Code. A second run allow-lists bare `Bash`, proving the
 * PreToolUse hook still fires under an allow rule. Gated on `--live` AND
 * `JEV_COPS_LIVE_CANARY=1`; never in CI: each run is a real model call billed to the user.
 *
 * The prompt goes right after `-p`: `--allowedTools` takes several values and would read a
 * trailing prompt as one more tool.
 */
import { randomUUID } from "node:crypto";
import { readAudit } from "@jev-cops/daemon";
import { type Check, check, type DoctorEnv } from "./doctor-types.ts";

const GROUP = "live canary";
/** The environment switch that, with `--live`, allows the real model call. */
export const LIVE_ENV = "JEV_COPS_LIVE_CANARY";
/** Printed (stderr) before the first live run. */
export const LIVE_NOTICE =
  "cops doctor --live: running `claude -p` twice; these are real model calls billed to your Claude account.";
const RUN_TIMEOUT_MS = 180_000;
const CASES = [
  { name: "live: Bash(printf *) allowed", allowed: "Bash(printf *)" },
  { name: "live: bare Bash allowed (§2 row 7)", allowed: "Bash" },
] as const;

/** What the live canary needs: the doctor's env, copsd's audit log, where to print the notice. */
export interface LiveOptions {
  readonly e: DoctorEnv;
  readonly auditPath: string;
  readonly notice: (line: string) => void;
}

function sessionIdOf(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout.trim()) as { session_id?: unknown };
    return typeof value.session_id === "string" && value.session_id !== ""
      ? value.session_id
      : null;
  } catch {
    return null;
  }
}

function judged(auditPath: string, sessionId: string, marker: string): string | null {
  const root = `sess_${sessionId}`;
  const line = readAudit(auditPath).lines.find(
    (l) =>
      l.kind === "judge" &&
      (l.session_id === root || String(l.session_id ?? "").startsWith(`${root}.`)) &&
      JSON.stringify(l.payload).includes(marker),
  );
  return line === undefined ? null : (line.event_id ?? "?");
}

async function liveCase(o: LiveOptions, claude: string, c: (typeof CASES)[number]): Promise<Check> {
  const marker = `jev-cops-canary-${randomUUID().replaceAll("-", "")}`;
  const prompt = `Run exactly this shell command and nothing else: printf ${marker}`;
  const argv = [
    claude,
    "-p",
    prompt,
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    "2",
    "--output-format",
    "json",
    "--allowedTools",
    c.allowed,
  ];
  const env = { ...o.e.env, HOME: o.e.home };
  const res = await o.e.run({ argv, env, cwd: o.e.cwd, stdin: "", timeoutMs: RUN_TIMEOUT_MS });
  const sessionId = sessionIdOf(res.stdout);
  if (sessionId === null) {
    const why =
      res.error ??
      `exit ${res.exitCode ?? "timeout"}${res.stderr.trim() === "" ? "" : `: ${res.stderr.trim().split("\n")[0]}`}`;
    return check(GROUP, c.name, "fail", `claude gave no session_id (${why})`);
  }
  const eventId = judged(o.auditPath, sessionId, marker);
  if (eventId !== null)
    return check(
      GROUP,
      c.name,
      "ok",
      `copsd judged the call (event ${eventId}, session sess_${sessionId})`,
    );
  return check(
    GROUP,
    c.name,
    "fail",
    `no judge line for sess_${sessionId} with ${marker} in ${o.auditPath}: the hook did not reach copsd for a real claude run (gate silently disabled), or the model did not run the command`,
  );
}

/** The live canary's checks: skipped (warn) unless enabled and `claude` is on PATH. */
export async function liveCanaryChecks(o: LiveOptions): Promise<Check[]> {
  if (o.e.env[LIVE_ENV] !== "1") {
    return [
      check(
        GROUP,
        "live",
        "warn",
        `skipped: set ${LIVE_ENV}=1 with --live to run it (real model calls billed to your Claude account; never in CI)`,
      ),
    ];
  }
  const claude = o.e.which("claude");
  if (claude === null) return [check(GROUP, "live", "warn", "skipped: claude is not on PATH")];
  o.notice(LIVE_NOTICE);
  const checks: Check[] = [];
  for (const c of CASES) checks.push(await liveCase(o, claude, c));
  return checks;
}
