#!/usr/bin/env bun
/**
 * `bun run pack:smoke`: proves the npm packages work without the repository.
 *
 * 1. Packs every publishable package with `bun pm pack` and checks each tarball
 *    (`scripts/pack-lib.ts`: file list, manifest, entries, imports, secrets).
 * 2. Installs the `jev-cops` tarball globally with `bun add -g` into a temp `BUN_INSTALL`,
 *    with a temp `HOME`, `XDG_*` and package cache; the `@jev-cops/*` dependencies resolve
 *    to the other tarballs through `overrides` (they are not on the registry yet), every
 *    third-party dependency comes from the registry (network needed).
 * 3. From an empty directory outside the repository, with only the temp bin dir and Bun on
 *    `PATH`, runs: `cops --help`, `copsd --help`, `cops-hook --version`, the bash grammar
 *    loaded from the installed `@jev-cops/core`, `cops test <installed @jev-cops/policies>`,
 *    `copsd --enforce` with no config (so on the installed starter set), one fixture event
 *    judged through `cops-hook`, an agent write to the installed code (killed), `cops install
 *    claude-code --dry-run` then for real (its canary runs through the installed hook),
 *    `cops doctor`, `cops install pi`.
 *
 * Nothing touches the real home. Exit 0 when every step passed; the temp directory is
 * removed unless `--keep` is given.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packAll, REPO, releaseVersion, workspacePackages } from "./pack-lib.ts";

const keep = process.argv.includes("--keep");
/** Short: Unix socket paths under the temp HOME must fit `sun_path` (104 bytes on macOS). */
const root = realpathSync(mkdtempSync(join(tmpdir(), "jcs-")));
const home = join(root, "h");
const bunInstall = join(root, "b");
const work = join(root, "w");
const globalModules = join(bunInstall, "install", "global", "node_modules");
const bunDir = dirname(process.execPath);
const version = releaseVersion(workspacePackages());
let failures = 0;

/** Proxy and CI variables pass through; nothing else from the real environment. */
function baseEnv(): Record<string, string> {
  const passed = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: `${join(bunInstall, "bin")}:${bunDir}:/usr/bin:/bin`,
  };
  for (const k of passed) if (process.env[k] !== undefined) env[k] = process.env[k] ?? "";
  return env;
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], opts: { env?: Record<string, string>; stdin?: string } = {}) {
  const proc = Bun.spawn(argv, {
    cwd: work,
    env: opts.env ?? baseEnv(),
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err } satisfies Ran;
}

function step(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  const shown = detail.trim().split("\n").slice(0, 12).join("\n      ");
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"}  ${name}${shown === "" ? "" : `\n      ${shown}`}\n`,
  );
}

function abridged(files: readonly string[]): string {
  if (files.length <= 8) return files.join(" ");
  return `${files.slice(0, 6).join(" ")} … (${files.length - 6} more)`;
}

async function packStep() {
  process.stdout.write(`pack-smoke: jev-cops ${version} in ${root}\n\n`);
  const packed = await packAll(join(root, "pack"));
  for (const p of packed) {
    const m = p.unpacked.manifest;
    const deps = Object.entries(m.dependencies ?? {}).map(([d, r]) => `${d}@${r}`);
    const bins = Object.keys(m.bin ?? {});
    const detail = [
      `${p.unpacked.files.length} files: ${abridged(p.unpacked.files)}`,
      `deps: ${deps.join(", ") || "none"}${bins.length > 0 ? ` · bins: ${bins.join(", ")}` : ""}`,
      ...p.problems,
    ].join("\n");
    step(`pack ${m.name}@${m.version}`, p.problems.length === 0, detail);
  }
  return packed;
}

async function installStep(tarballs: ReadonlyMap<string, string>) {
  const globalDir = join(bunInstall, "install", "global");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const overrides = Object.fromEntries([...tarballs].filter(([name]) => name !== "jev-cops"));
  await Bun.write(join(globalDir, "package.json"), JSON.stringify({ overrides }, null, 2));
  const env = {
    ...baseEnv(),
    BUN_INSTALL: bunInstall,
    BUN_INSTALL_CACHE_DIR: join(root, "cache"),
  };
  const r = await run(["bun", "add", "-g", tarballs.get("jev-cops") ?? ""], { env });
  const bins = ["cops", "copsd", "cops-hook"].map((b) => join(bunInstall, "bin", b));
  step("bun add -g jev-cops (temp BUN_INSTALL and HOME)", r.code === 0, r.code === 0 ? "" : r.err);
  step("the cops, copsd and cops-hook bins are linked", bins.every(existsSync), bins.join("\n"));
}

async function commandSteps(): Promise<string> {
  const cops = await run(["cops", "--help"]);
  step("cops --help", cops.code === 0 && cops.out.includes(`cops ${version}`), cops.err);
  const copsd = await run(["copsd", "--help"]);
  step("copsd --help", copsd.code === 0 && copsd.out.includes(`copsd ${version}`), copsd.err);
  const hook = await run(["cops-hook", "--version"]);
  step("cops-hook --version", hook.code === 0 && hook.out.trim() === version, hook.out + hook.err);
  const parser = join(globalModules, "@jev-cops", "core", "src", "normalizer", "parser.ts");
  const probe = `const { parseBash } = await import(${JSON.stringify(parser)});
const kind = await parseBash("git push --force origin main", (root) => root.child(0)?.type);
const from = ${JSON.stringify(dirname(parser))};
console.log(kind, Bun.resolveSync("tree-sitter-bash/tree-sitter-bash.wasm", from));`;
  // --no-install: never let Bun fetch a package of its own for the probe.
  const wasm = await run(["bun", "--no-install", "-e", probe]);
  const grammar = join(globalModules, "tree-sitter-bash", "tree-sitter-bash.wasm");
  const loaded = wasm.out.trim() === `command ${grammar}`;
  step("the bash grammar (WASM) loads from the installed tree", loaded, wasm.out + wasm.err);
  const manifest = Bun.resolveSync(
    "@jev-cops/policies/package.json",
    join(globalModules, "jev-cops"),
  );
  const policies = realpathSync(dirname(manifest));
  const tested = await run(["cops", "test", policies]);
  step(
    `cops test ${policies}`,
    tested.code === 0 && tested.out.includes("→ PASS"),
    tested.out.split("\n").slice(-2).join("\n") + tested.err,
  );
  return policies;
}

let sessions = 0;

/**
 * A Claude Code PreToolUse payload from the repo's fixtures, run from the temp work dir, in
 * a session of its own (a kill latches its session: a later probe must not ride on it).
 */
function preToolUse(tool: string, input: Record<string, unknown>): string {
  const fixture = join(REPO, "tests", "fixtures", "claude-code", "pre-tool-use.bash.json");
  const base = JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>;
  sessions += 1;
  const ids = { session_id: `pack-smoke-${sessions}`, tool_use_id: `toolu_smoke${sessions}` };
  return JSON.stringify({ ...base, ...ids, cwd: work, tool_name: tool, tool_input: input });
}

async function waitForHealth(socket: string): Promise<{ policies?: { name: string }[] } | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      const health = await fetch("http://localhost/v1/health", { unix: socket }).then(
        (r) => (r.ok ? (r.json() as Promise<{ policies?: { name: string }[] }>) : null),
        () => null,
      );
      if (health !== null) return health;
    }
    await Bun.sleep(100);
  }
  return null;
}

async function hookSteps() {
  const judged = await run(["cops-hook", "--harness", "claude-code"], {
    stdin: preToolUse("Bash", { command: "npm test", description: "Run test suite" }),
  });
  step(
    "fixture event (Bash npm test) judged through cops-hook → allowed",
    judged.code === 0,
    judged.out + judged.err,
  );
  const settings = join(home, ".claude", "settings.json");
  const tamper = await run(["cops-hook", "--harness", "claude-code"], {
    stdin: preToolUse("Write", { file_path: settings, content: "{}" }),
  });
  const killed = (r: Ran) => r.code === 2 && r.out.includes('"continue":false');
  step("Write to ~/.claude/settings.json → killed (config-tamper)", killed(tamper), tamper.err);
  const code = join(globalModules, "@jev-cops", "core", "src", "index.ts");
  const edit = await run(["cops-hook", "--harness", "claude-code"], {
    stdin: preToolUse("Write", { file_path: code, content: "export {};" }),
  });
  const why = "would change the harness or judge configuration";
  const guarded = killed(edit) && edit.err.includes(why);
  step("Write to the installed @jev-cops code → killed (a protected input)", guarded, edit.err);
}

async function installSteps() {
  const hookBin = join(globalModules, "jev-cops", "bin", "cops-hook.ts");
  const dry = await run(["cops", "install", "claude-code", "--home", home, "--dry-run"]);
  const found = dry.out.includes(`hook ${hookBin} (version ${version})`);
  step(
    "cops install claude-code --dry-run finds the installed cops-hook",
    dry.code === 0 && found,
    dry.out
      .split("\n")
      .filter((l) => l.startsWith("jev-cops: hook") || l.includes(`warning: ${hookBin}`))
      .join("\n") + dry.err,
  );
  const real = await run(["cops", "install", "claude-code", "--home", home]);
  step(
    "cops install claude-code (canary through the installed hook)",
    real.code === 0,
    real.out
      .split("\n")
      .filter((l) => /canary|installed|error/.test(l))
      .join("\n") + real.err,
  );
  const doctor = await run([
    "cops",
    "doctor",
    "--harness",
    "claude-code",
    "--home",
    home,
    "--json",
  ]);
  type Check = { group: string; name: string; status: string; detail: string };
  const checks = (JSON.parse(doctor.out || "{}") as { checks?: Check[] }).checks ?? [];
  const failed = checks.filter((c) => c.status === "fail");
  const shown = failed.map((c) => `fail ${c.group}/${c.name}: ${c.detail}`).join("\n");
  // No `claude` on the smoke PATH: only the checks that need the claude binary may fail.
  const unexpected = failed.filter((c) => !/claude/i.test(`${c.name} ${c.detail}`));
  step(
    "cops doctor: daemon, audit chain, hook and canary checks pass",
    unexpected.length === 0,
    shown,
  );
  const pi = await run(["cops", "install", "pi", "--home", home]);
  const piFile = join(home, ".pi", "agent", "extensions", "jev-cops.ts");
  const baked = existsSync(piFile) && readFileSync(piFile, "utf8").includes("INSTALLED_SOCKET");
  step(
    "cops install pi copies the extension from the installed package",
    pi.code === 0 && baked,
    pi.err,
  );
}

async function daemonSteps(policies: string) {
  const socket = join(home, ".jev-cops", "copsd.sock");
  const daemon = Bun.spawn(["copsd", "--enforce"], {
    cwd: work,
    env: baseEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const health = await waitForHealth(socket);
  const names = health?.policies?.map((p) => p.name) ?? [];
  step(
    "copsd --enforce with no config serves the installed starter set",
    names.includes("config-tamper"),
    names.join(", "),
  );
  try {
    if (health !== null) {
      await hookSteps();
      await installSteps();
    }
  } finally {
    daemon.kill("SIGTERM");
    const code = await daemon.exited;
    const err = await new Response(daemon.stderr).text();
    const boot = err.split("\n").find((l) => l.startsWith("copsd listening")) ?? err;
    step(
      "copsd boot line names the installed policies; clean exit on SIGTERM",
      code === 0 && boot.includes(`from ${policies}`),
      boot,
    );
  }
}

try {
  const packed = await packStep();
  if (failures === 0) {
    await installStep(new Map(packed.map((p) => [p.pkg.manifest.name, p.tgz])));
    const policies = await commandSteps();
    await daemonSteps(policies);
  }
} catch (cause) {
  step(
    "pack-smoke",
    false,
    cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  );
} finally {
  if (keep) process.stdout.write(`\nkept ${root}\n`);
  else rmSync(root, { recursive: true, force: true });
}
process.stdout.write(`\npack-smoke: ${failures === 0 ? "PASS" : `${failures} step(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
