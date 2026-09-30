/**
 * `cops doctor`, Pi (PLAN-M1 §4.4; docs/adapters.md#pi): the extension file in Pi's global
 * (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`) or project extensions directory, the socket it
 * talks to (baked in by `cops install pi`, else `$JEV_COPS_SOCKET` or the default at run
 * time) against copsd's, and whether the file is still what the installer writes. Then the
 * known gaps, which are always printed (spec: never silent). Read-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionSource, INSTALLED_FILE } from "@jev-cops/adapter-pi/install";
import { type Check, check, type DoctorEnv } from "./doctor-types.ts";

const GROUP = "pi";
const SOCKET_LINE = /^const INSTALLED_SOCKET: string \| null = (.*);$/m;

/** One installed copy of the extension. */
interface PiInstall {
  readonly path: string;
  readonly scope: "global" | "project";
  readonly text: string;
  /** The baked socket, null when none was baked, undefined when the line is missing or odd. */
  readonly baked: string | null | undefined;
}

function agentDir(e: DoctorEnv): string {
  return e.env.PI_CODING_AGENT_DIR || join(e.home, ".pi", "agent");
}

function bakedSocket(text: string): string | null | undefined {
  const raw = SOCKET_LINE.exec(text)?.[1];
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value === null || typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function installs(e: DoctorEnv): PiInstall[] {
  const places = [
    { scope: "global" as const, path: join(agentDir(e), "extensions", INSTALLED_FILE) },
    { scope: "project" as const, path: join(e.cwd, ".pi", "extensions", INSTALLED_FILE) },
  ];
  return places.flatMap(({ scope, path }) => {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    return [{ path, scope, text, baked: bakedSocket(text) }];
  });
}

function socketCheck(i: PiInstall, e: DoctorEnv, daemonSocket: string): Check {
  if (i.baked === undefined) {
    return check(
      GROUP,
      "socket",
      "warn",
      `${i.path} has no INSTALLED_SOCKET line the installer writes: not jev-cops's extension, or edited`,
    );
  }
  if (i.baked !== null) {
    if (i.baked === daemonSocket) return check(GROUP, "socket", "ok", `baked in: ${i.baked}`);
    return check(
      GROUP,
      "socket",
      "fail",
      `${i.path} talks to ${i.baked}, copsd listens on ${daemonSocket}: Pi blocks every tool but read-only ones (fail closed)`,
    );
  }
  const runtime = e.env.JEV_COPS_SOCKET || join(e.home, ".jev-cops", "copsd.sock");
  if (runtime === daemonSocket)
    return check(GROUP, "socket", "ok", `resolved at run time: ${runtime}`);
  return check(
    GROUP,
    "socket",
    "warn",
    `resolved at run time from $JEV_COPS_SOCKET or the default, here ${runtime}, but copsd listens on ${daemonSocket}; Pi's own environment decides. Bake it in: \`cops install pi --socket ${daemonSocket}\``,
  );
}

function contentCheck(i: PiInstall): Check {
  if (i.baked === undefined) {
    return check(
      GROUP,
      "extension content",
      "warn",
      `${i.path} is not the installer's output; reinstall with \`cops install pi\``,
    );
  }
  let expected: string;
  try {
    expected = extensionSource(i.baked);
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    return check(
      GROUP,
      "extension content",
      "warn",
      `cannot compare ${i.path} with this release's extension (${why})`,
    );
  }
  if (expected === i.text)
    return check(GROUP, "extension content", "ok", "the file is this release's extension");
  return check(
    GROUP,
    "extension content",
    "warn",
    `${i.path} differs from this release's extension (edited, or another version); without OpenShell the agent can edit it (T1). Reinstall with \`cops install pi\``,
  );
}

function installedCheck(i: PiInstall): Check {
  const note =
    i.scope === "project"
      ? "project install: Pi loads it only after the project is trusted"
      : "global install: every project";
  return check(GROUP, "extension", "ok", `${i.path} (${note})`);
}

function missing(e: DoctorEnv, explicit: boolean): Check {
  const where = `${join(agentDir(e), "extensions")} or ${join(e.cwd, ".pi", "extensions")}`;
  const detected = explicit || e.which("pi") !== null || existsSync(agentDir(e));
  if (!detected) {
    return check(
      GROUP,
      "extension",
      "warn",
      `Pi not detected (no pi on PATH, no ${agentDir(e)}): skipped; \`cops doctor --harness pi\` checks it anyway`,
    );
  }
  return check(
    GROUP,
    "extension",
    "fail",
    `no ${INSTALLED_FILE} in ${where}: Pi runs every tool unjudged; run \`cops install pi\``,
  );
}

/** The Pi checks; `explicit` when `--harness pi` asked for them (a missing install then fails). */
export function piChecks(e: DoctorEnv, daemonSocket: string, explicit: boolean): Check[] {
  const found = installs(e);
  if (found.length === 0) return [missing(e, explicit)];
  return found.flatMap((i) => [
    installedCheck(i),
    socketCheck(i, e, daemonSocket),
    contentCheck(i),
  ]);
}

/** One `gap` line per known unclosable bypass, in order (spec: "never silent"). */
export function gapChecks(group: string, gaps: readonly string[]): Check[] {
  return gaps.map((gap, i) => check(group, `gap ${i + 1}`, "gap", gap));
}
