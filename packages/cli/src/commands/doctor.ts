/**
 * `cops doctor [--harness claude-code|pi|all] [--live] [--json] [--socket path]
 * [--admin-socket path] [--config path] [--home path] [--audit-pubkey path] [--audit-remote
 * path]` (PLAN-M1 §4.3–4.4, PLAN-M2 §6): checks copsd on
 * both sockets, the audit log (chain, signed checkpoints, signing key, forwarding, the
 * off-box copy), each harness's install, runs the offline canary through
 * the registered hook, optionally the live canary, and prints every known gap (spec:
 * "Every bypass we know we cannot close is printed by `doctor` … never silent").
 * It writes no configuration (a harness's or its own); the offline canary leaves its calls
 * in copsd's audit log and latches its throw-away session there (D-091), which the report says.
 * Exit 0 when nothing failed (warnings and gaps included), 1 when a check failed, 2 on usage.
 */
import { parseArgs } from "node:util";
import { EXIT, type Io } from "../io.ts";
import { processDoctorEnv } from "./doctor-process.ts";
import { exitCodeOf, renderHuman, renderJson } from "./doctor-render.ts";
import { type DoctorDeps, type DoctorOptions, runDoctor } from "./doctor-run.ts";
import type { HarnessChoice } from "./doctor-types.ts";

const HARNESSES: readonly HarnessChoice[] = ["claude-code", "pi", "all"];

/** Parsed arguments, or why they are refused. */
export type DoctorArgs =
  | {
      readonly ok: true;
      readonly options: DoctorOptions;
      readonly json: boolean;
      readonly home: string | null;
    }
  | { readonly ok: false; readonly error: string };

/** Parses `cops doctor`'s arguments (strict: unknown options and positionals are refused). */
export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  const options = {
    harness: { type: "string" },
    live: { type: "boolean" },
    json: { type: "boolean" },
    socket: { type: "string" },
    "admin-socket": { type: "string" },
    config: { type: "string" },
    home: { type: "string" },
    "audit-pubkey": { type: "string" },
    "audit-remote": { type: "string" },
  } as const;
  let values: {
    harness?: string;
    live?: boolean;
    json?: boolean;
    socket?: string;
    "admin-socket"?: string;
    config?: string;
    home?: string;
    "audit-pubkey"?: string;
    "audit-remote"?: string;
  };
  try {
    ({ values } = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false }));
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  const harness = (values.harness ?? "all") as HarnessChoice;
  if (!HARNESSES.includes(harness))
    return { ok: false, error: `--harness must be one of ${HARNESSES.join(", ")}` };
  const opt = <K extends string>(key: K, value: string | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    ok: true,
    options: {
      harness,
      live: values.live === true,
      ...opt("socket", values.socket),
      ...opt("adminSocket", values["admin-socket"]),
      ...opt("config", values.config),
      ...opt("auditPubkey", values["audit-pubkey"]),
      ...opt("auditRemote", values["audit-remote"]),
    },
    json: values.json === true,
    home: values.home ?? null,
  };
}

/** The real process: its environment (home from `--home`) and stderr notices. */
export interface DoctorProcess {
  deps(home: string | null, io: Io): DoctorDeps;
  readonly tty: boolean;
}

/** The doctor as this process runs it (`cops doctor`). */
export const PROCESS_DOCTOR: DoctorProcess = {
  deps: (home, io) => ({
    env: processDoctorEnv(home === null ? {} : { home }),
    notice: (line) => io.err(line),
  }),
  get tty() {
    return process.stdout.isTTY === true;
  },
};

/** Runs `cops doctor`; resolves with the exit code. */
export async function runDoctorCommand(
  argv: readonly string[],
  io: Io,
  proc: DoctorProcess = PROCESS_DOCTOR,
): Promise<number> {
  const args = parseDoctorArgs(argv);
  if (!args.ok) {
    io.err(`cops doctor: ${args.error}`);
    return EXIT.usage;
  }
  const checks = await runDoctor(args.options, proc.deps(args.home, io));
  if (args.json) io.out(renderJson(checks, args.options.harness));
  else io.out(renderHuman(checks, proc.tty).join("\n"));
  return exitCodeOf(checks);
}
