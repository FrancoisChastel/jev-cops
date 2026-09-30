/**
 * Test setup for `cops doctor`: a temp root holding a home, a project and a `bin` directory
 * that is the whole `PATH` (so no real `claude` or `pi` can ever be found), stand-in
 * executables, and the doctor environment over them. Nothing here touches the real home.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DaemonConfig } from "@jev-cops/daemon";
import { jevCopsSettings } from "../../../../adapters/claude-code/testing/setup.ts";
import { spawnProcess } from "../commands/doctor-process.ts";
import type { DoctorEnv, Env } from "../commands/doctor-types.ts";

/** The repository's starter policies (config-tamper included). */
export const REPO_POLICIES = join(import.meta.dir, "..", "..", "..", "..", "policies");

/** A temp root for one doctor test: home, project (the cwd), `bin` (the PATH), managed dir. */
export interface DoctorFixture {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly bin: string;
  readonly managed: string;
  dispose(): void;
}

/** Creates a fresh fixture (real paths: macOS temp dirs are symlinks). */
export function doctorFixture(): DoctorFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jvdoc-")));
  const [home, project, bin, managed] = ["home", "project", "bin", "managed"].map((d) => {
    const path = join(root, d);
    mkdirSync(path);
    return path;
  }) as [string, string, string, string];
  return {
    root,
    home,
    project,
    bin,
    managed,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The doctor's environment over a fixture: PATH is the fixture's `bin` only. */
export function doctorEnv(f: DoctorFixture, env: Env = {}): DoctorEnv {
  const full: Env = { PATH: f.bin, HOME: f.home, ...env };
  return {
    home: f.home,
    cwd: f.project,
    env: full,
    platform: "linux",
    managedDir: f.managed,
    which: (name) => Bun.which(name, { PATH: full.PATH ?? "" }),
    run: spawnProcess,
  };
}

/** Writes JSON to `path`, creating its directory. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** The user settings file of a fixture. */
export function userSettingsPath(f: DoctorFixture): string {
  return join(f.home, ".claude", "settings.json");
}

/** Registers the jev-cops hook (the adapter's source entry under this Bun) in user settings. */
export function installHook(
  f: DoctorFixture,
  socket: string,
  extra: Record<string, unknown> = {},
  binary?: string,
): Record<string, unknown> {
  const settings = { ...jevCopsSettings(socket, binary), ...extra };
  writeJson(userSettingsPath(f), settings);
  return settings;
}

/** Writes an executable `sh` script named `name` into `dir`. */
export function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A `cops.toml` pointing the doctor at a test daemon's sockets, audit log, keys and home. */
export function copsToml(f: DoctorFixture, config: DaemonConfig): string {
  const path = join(f.root, "cops.toml");
  const d = config.daemon;
  const lines = [
    "[daemon]",
    `socket = ${JSON.stringify(d.socket)}`,
    `admin_socket = ${JSON.stringify(d.adminSocket)}`,
    `home = ${JSON.stringify(d.home)}`,
    "[audit]",
    `path = ${JSON.stringify(config.audit.path)}`,
    `key = ${JSON.stringify(config.audit.key)}`,
    `public_key = ${JSON.stringify(config.audit.publicKey)}`,
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** The trust record of `dir` in the fixture's `~/.claude.json`. */
export function trust(f: DoctorFixture, dir: string, accepted = true): void {
  writeJson(join(f.home, ".claude.json"), {
    projects: { [dir]: { hasTrustDialogAccepted: accepted } },
  });
}

/** The stand-in `claude` of the live canary (testing/fake-claude.ts), on the fixture's PATH. */
export function standInClaude(f: DoctorFixture, version = "2.1.285"): string {
  const script = join(import.meta.dir, "fake-claude.ts");
  const run = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`;
  const body = `export FAKE_CLAUDE_VERSION=${JSON.stringify(version)}\n${run}`;
  return executable(f.bin, "claude", body);
}
