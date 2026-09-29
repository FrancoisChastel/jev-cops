#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { err, ok, type Result } from "@jevdict/core";
import { registerSdkModule } from "@jevdict/sdk/register";
import {
  type DaemonConfig,
  type EnforcementMode,
  type HttpBind,
  loadConfig,
  parseHttpBind,
} from "./config.ts";
import { DAEMON_VERSION } from "./daemon.ts";
import { stderrLogger } from "./log.ts";
import { type RunningDaemon, startDaemon } from "./server.ts";

export const DAEMON_USAGE = `jevdictd ${DAEMON_VERSION} — the Jevdict judging daemon

Usage: jevdictd [--config path] [--socket path] [--http host:port] [--observe|--enforce]

  --config <path>   jevdict.toml to load on top of ~/.config/jevdict/jevdict.toml,
                    ./.jevdict.toml (tighten-only) and $JEVDICT_CONFIG
  --socket <path>   Unix socket to listen on (default ~/.jevdict/jevdictd.sock)
  --http <h:p>      also listen on loopback HTTP (127.0.0.1, ::1 or localhost only)
  --observe         log every verdict, return allow (the default)
  --enforce         return verdicts as judged
  -h, --help        this text

Exit codes: 0 clean shutdown (SIGTERM/SIGINT) · 1 boot failure · 2 usage error`;

/** Command-line overrides on top of the loaded config. */
export interface DaemonArgs {
  readonly help: boolean;
  readonly configPath?: string;
  readonly socket?: string;
  readonly http?: HttpBind;
  readonly mode?: EnforcementMode;
}

function modeOf(values: {
  observe?: boolean;
  enforce?: boolean;
}): Result<EnforcementMode | null, string> {
  if (values.observe === true && values.enforce === true) {
    return err("--observe and --enforce are exclusive");
  }
  if (values.observe === true) return ok("observe");
  return ok(values.enforce === true ? "enforce" : null);
}

/** Parses `jevdictd` arguments; never throws. */
export function parseDaemonArgs(argv: readonly string[]): Result<DaemonArgs, string> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string" },
        socket: { type: "string" },
        http: { type: "string" },
        observe: { type: "boolean" },
        enforce: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
  const mode = modeOf(values as { observe?: boolean; enforce?: boolean });
  if (!mode.ok) return mode;
  const http = typeof values.http === "string" ? parseHttpBind(values.http) : null;
  if (http !== null && !http.ok) return err(http.error);
  return ok({
    help: values.help === true,
    ...(typeof values.config === "string" ? { configPath: values.config } : {}),
    ...(typeof values.socket === "string" ? { socket: values.socket } : {}),
    ...(http === null ? {} : { http: http.value }),
    ...(mode.value === null ? {} : { mode: mode.value }),
  });
}

/** The loaded config with command-line overrides applied. */
export function applyArgs(config: DaemonConfig, args: DaemonArgs): DaemonConfig {
  return {
    ...config,
    daemon: {
      ...config.daemon,
      ...(args.socket === undefined ? {} : { socket: resolve(args.socket) }),
      ...(args.http === undefined ? {} : { http: args.http }),
    },
    enforcement: args.mode === undefined ? config.enforcement : { mode: args.mode },
  };
}

function bootLine(d: RunningDaemon): string {
  const count = d.runtime.policies.current().policies.length;
  const judge = d.runtime.judgeName === "disabled" ? "off" : d.runtime.judgeName;
  const http = d.listening.httpUrl === null ? "" : ` and ${d.listening.httpUrl}`;
  return [
    `jevdictd listening on ${d.listening.socket}${http}`,
    `${count} ${count === 1 ? "policy" : "policies"}`,
    `judge ${judge}`,
    `enforcement ${d.runtime.config.enforcement.mode}`,
  ].join(" · ");
}

async function boot(argv: readonly string[]): Promise<RunningDaemon | number> {
  const args = parseDaemonArgs(argv);
  if (!args.ok) {
    process.stderr.write(`jevdictd: ${args.error}\n\n${DAEMON_USAGE}\n`);
    return 2;
  }
  if (args.value.help) {
    process.stdout.write(`${DAEMON_USAGE}\n`);
    return 0;
  }
  try {
    const loaded = loadConfig(
      args.value.configPath === undefined ? {} : { configPath: args.value.configPath },
    );
    for (const r of loaded.rejected) process.stderr.write(`WARNING: ${r}\n`);
    const daemon = await startDaemon(applyArgs(loaded.config, args.value), { log: stderrLogger() });
    process.stderr.write(`${bootLine(daemon)}\n`);
    for (const w of daemon.runtime.warnings) process.stderr.write(`WARNING: ${w}\n`);
    return daemon;
  } catch (cause) {
    process.stderr.write(`jevdictd: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

/** Boots `jevdictd` and resolves with its exit code once SIGTERM/SIGINT stops it. */
export async function main(argv: readonly string[]): Promise<number> {
  const booted = await boot(argv);
  if (typeof booted === "number") return booted;
  return new Promise<number>((done) => {
    const shutdown = () => {
      booted.stop().then(
        () => done(0),
        (cause: unknown) => {
          process.stderr.write(`jevdictd: shutdown failed: ${String(cause)}\n`);
          done(1);
        },
      );
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

if (import.meta.main) {
  registerSdkModule();
  process.exit(await main(process.argv.slice(2)));
}
