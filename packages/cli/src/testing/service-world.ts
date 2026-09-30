/**
 * Test support for `cops service`: a throw-away root with a home and a bin directory holding
 * a compiled-looking `cops` and `copsd`, a runner that records every service-manager command
 * and answers from a script (it never runs `launchctl` or `systemctl`), and a scripted health
 * probe. Nothing here reads or writes the real home directory.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthResult, RunResult, ServiceContext } from "../service/context.ts";

/** The world and the contexts that run in it. */
export interface ServiceWorld {
  readonly root: string;
  readonly home: string;
  readonly copsd: string;
  /** Every argv the runner was given, oldest first. */
  readonly calls: string[][];
  /** How many times the health probe was asked. */
  healthCalls(): number;
  /** Scripts the answer to a subcommand (`bootstrap`, `print`, `enable`, `show`, …). */
  respond(subcommand: string, result: Partial<RunResult>): void;
  setHealth(result: HealthResult): void;
  ctx(over?: Partial<ServiceContext>): ServiceContext;
  /** A factory for `runServiceCommand`: `--home` sets `home`; the real home stays the world's. */
  factory(over?: Partial<ServiceContext>): (home: string | null) => ServiceContext;
  dispose(): void;
}

/** The subcommand of a launchctl or `systemctl --user` argv. */
export function subcommandOf(argv: readonly string[]): string {
  return (argv[1] === "--user" ? argv[2] : argv[1]) ?? "";
}

/** Creates the world; call `dispose` in `afterEach`. */
export function serviceWorld(): ServiceWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jvsvc-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const copsd = join(bin, "copsd");
  writeFileSync(copsd, "#!/bin/sh\n");
  chmodSync(copsd, 0o755);
  const calls: string[][] = [];
  const answers = new Map<string, RunResult>();
  let health: HealthResult = { ok: true, detail: "copsd answers /v1/health (test)" };
  let asked = 0;
  const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
    home,
    realHome: home,
    platform: "darwin",
    uid: 501,
    runtime: { execPath: join(bin, "cops"), main: "/$bunfs/root/cops" },
    run: async (argv) => {
      calls.push([...argv]);
      return answers.get(subcommandOf(argv)) ?? { code: 0, stdout: "", stderr: "" };
    },
    health: async () => {
      asked += 1;
      return health;
    },
    resolveDaemonEntry: () => null,
    launchctl: "/bin/launchctl",
    systemctl: "/usr/bin/systemctl",
    ...over,
  });
  return {
    root,
    home,
    copsd,
    calls,
    healthCalls: () => asked,
    respond: (sub, r) => answers.set(sub, { code: 0, stdout: "", stderr: "", ...r }),
    setHealth: (r) => {
      health = r;
    },
    ctx,
    factory:
      (over = {}) =>
      (h) =>
        ctx({ ...over, ...(h === null ? {} : { home: h }) }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
