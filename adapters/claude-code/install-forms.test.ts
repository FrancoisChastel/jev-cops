/**
 * F1 of the Docker e2e (docs/captures/claude-code-docker.md): the hook must recognise the
 * entry the installer registers, for every form an install can take. Each case writes user
 * settings the way the installer does (mergeHooks + jevCopsHookEntries, or by hand for the
 * forms only a human writes), spawns the hook exactly as registered with a ConfigChange for
 * that unchanged file, and reads the verdict the hook reports to a stand-in daemon.
 * A hook that does not find itself would block and latch every session whose settings change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  HOOK_TIMEOUTS_S,
  type HookEntries,
  INSTALLED_EVENTS,
  type InstalledEvent,
  jevCopsHookEntries,
} from "./src/hook-entries.ts";
import { mergeHooks } from "./src/settings-merge.ts";
import { spawnHook } from "./testing/hook-run.ts";
import { HOOK_SOURCE } from "./testing/setup.ts";

const REPO = join(import.meta.dir, "..", "..");
const ADAPTER = join(REPO, "adapters", "claude-code");
const META_HOOK = join(REPO, "packages", "jev-cops", "bin", "cops-hook.ts");
const CLI_MAIN = join(REPO, "packages", "cli", "src", "main.ts");

let root = "";
let home = "";
let bin = "";
let socket = "";
let compiled = "";
let server: Server<undefined>;
const reports: { kind?: string; intact?: boolean }[] = [];

async function build(args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", "build", ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvcc-forms-")));
  home = join(root, "home");
  bin = join(root, "bin");
  for (const d of [home, bin, join(root, "node_modules", "@jev-cops"), join(root, "dist")]) {
    mkdirSync(d, { recursive: true });
  }
  // `#!/usr/bin/env bun` finds this Bun, as it would on the user's PATH.
  symlinkSync(process.execPath, join(bin, "bun"));
  // What `bun add -g jev-cops` lays out: the meta package's bin next to the adapter it imports.
  mkdirSync(join(root, "node_modules", "jev-cops", "bin"), { recursive: true });
  copyFileSync(META_HOOK, join(root, "node_modules", "jev-cops", "bin", "cops-hook.ts"));
  symlinkSync(ADAPTER, join(root, "node_modules", "@jev-cops", "adapter-claude-code"));
  compiled = join(root, "dist", "cops-hook");
  await build(["--compile", HOOK_SOURCE, "--outfile", compiled]);
  socket = join(root, "d.sock");
  server = Bun.serve({
    unix: socket,
    fetch: async (req) => {
      reports.push((await req.json()) as (typeof reports)[number]);
      return Response.json({ ok: true, task: null, killed: false });
    },
  });
}, 60_000);

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const settingsPath = () => join(home, ".claude", "settings.json");
const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: home });

/**
 * User settings as the installer writes them: the user's own keys, then every event
 * (`jevCopsHookEntries`); with leading arguments (only a human writes those), by hand.
 */
function installed(command: string, leading: readonly string[] = []): void {
  const args = [...leading, "--harness", "claude-code", "--socket", socket];
  const byHand = (e: InstalledEvent) => [
    { hooks: [{ type: "command" as const, command, args, timeout: HOOK_TIMEOUTS_S[e] }] },
  ];
  const entries: HookEntries =
    leading.length === 0
      ? jevCopsHookEntries(command, socket)
      : (Object.fromEntries(INSTALLED_EVENTS.map((e) => [e, byHand(e)])) as unknown as HookEntries);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = mergeHooks({ theme: "dark" }, entries);
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

/** A ConfigChange for the unchanged user settings, through the hook as `argv` starts it. */
async function configChange(command: string, args: readonly string[]) {
  const session = `forms-${crypto.randomUUID()}`;
  const payload = JSON.stringify({
    session_id: session,
    transcript_path: join(root, "t.jsonl"),
    cwd: home,
    permission_mode: "default",
    hook_event_name: "ConfigChange",
    source: "user_settings",
    file_path: settingsPath(),
  });
  const opts = { env: env(), cwd: home, timeoutS: 30, headless: false, direct: true };
  const run = await spawnHook({ command, args }, payload, opts);
  const report = reports.find((r) => JSON.stringify(r).includes(session));
  return { run, intact: report?.intact ?? null };
}

const FLAGS = () => ["--harness", "claude-code", "--socket", socket];

describe("every install form finds itself intact on an unrelated settings change (F1)", () => {
  test("the npm meta package: node_modules/jev-cops/bin/cops-hook.ts through its shebang", async () => {
    const hook = join(root, "node_modules", "jev-cops", "bin", "cops-hook.ts");
    installed(hook);
    const r = await configChange(hook, FLAGS());
    expect({ exit: r.run.exitCode, stdout: r.run.stdout, intact: r.intact }).toEqual({
      exit: 0,
      stdout: "",
      intact: true,
    });
  }, 30_000);

  test("the adapter's hook-main.ts under node_modules (@jev-cops/cli without the meta package)", async () => {
    const hook = join(
      root,
      "node_modules",
      "@jev-cops",
      "adapter-claude-code",
      "src",
      "hook-main.ts",
    );
    installed(hook);
    const r = await configChange(hook, FLAGS());
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 0, intact: true });
  }, 30_000);

  test("the compiled binary (dist/cops-hook)", async () => {
    installed(compiled);
    const r = await configChange(compiled, FLAGS());
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 0, intact: true });
  }, 30_000);

  test("a bin symlink to the compiled binary", async () => {
    const link = join(bin, "cops-hook");
    rmSync(link, { force: true });
    symlinkSync(compiled, link);
    installed(link);
    const r = await configChange(link, FLAGS());
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 0, intact: true });
  }, 30_000);

  test("bun <script>: the source entry run by this Bun", async () => {
    installed(process.execPath, [HOOK_SOURCE]);
    const r = await configChange(process.execPath, [HOOK_SOURCE, ...FLAGS()]);
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 0, intact: true });
  }, 30_000);

  test("`cops hook`: the CLI entry with its subcommand", async () => {
    installed(CLI_MAIN, ["hook"]);
    const r = await configChange(CLI_MAIN, ["hook", ...FLAGS()]);
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 0, intact: true });
  }, 30_000);
});

describe("D-087 stays strict: another program is not this hook", () => {
  test("settings that register the compiled binary, checked by the npm hook: not intact", async () => {
    installed(compiled);
    const hook = join(root, "node_modules", "jev-cops", "bin", "cops-hook.ts");
    const r = await configChange(hook, FLAGS());
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 2, intact: false });
    expect(r.run.stderr).toContain("no cops hook on PreToolUse");
  }, 30_000);

  test("settings that register the npm hook, checked by the compiled binary: not intact", async () => {
    const hook = join(root, "node_modules", "jev-cops", "bin", "cops-hook.ts");
    installed(hook);
    const r = await configChange(compiled, FLAGS());
    expect({ exit: r.run.exitCode, intact: r.intact }).toEqual({ exit: 2, intact: false });
  }, 30_000);
});
