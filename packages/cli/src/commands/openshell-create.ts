/**
 * `cops openshell create <name> --harness …`: compiles the full policy (protection set,
 * judge route, registries, remote, any task hosts already known), writes it, prints the
 * `openshell` calls, and runs them only when `openshell` is found and `--dry-run` is not
 * given: `sandbox create --policy` (filesystem sections are creation-only, D-109) then the
 * advisor posture (D-119), stopping the sandbox if that posture cannot be pinned.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_SETTINGS,
  type CreateOptions,
  commandLine,
  openShellCli,
  sandboxCreate,
  sandboxCreateArgs,
  settingsSetArgs,
} from "@jev-cops/openshell";
import { EXIT, type Io } from "../io.ts";
import {
  COMPILE_OPTIONS,
  compileFor,
  openShellBinary,
  parse,
  type Values,
} from "./openshell-args.ts";

const CREATE_OPTIONS = {
  ...COMPILE_OPTIONS,
  from: { type: "string" },
  provider: { type: "string", multiple: true },
  env: { type: "string", multiple: true },
  "policy-out": { type: "string" },
} as const;

function list(v: Values, key: string): string[] {
  const value = v[key];
  return Array.isArray(value) ? value : [];
}

/** Writes the policy where `--policy-out` says, else to a fresh private temp dir. */
function writePolicy(yaml: string, out: string | null): string {
  const path = out ?? join(mkdtempSync(join(tmpdir(), "jev-cops-openshell-")), "policy.yaml");
  writeFileSync(path, yaml, { mode: 0o600 });
  return path;
}

function planned(o: CreateOptions): string[] {
  return [
    commandLine("openshell", sandboxCreateArgs(o)),
    ...ADVISOR_SETTINGS.map(([k, value]) =>
      commandLine("openshell", settingsSetArgs(o.name, k, value)),
    ),
  ];
}

/** Splits `argv` at `--`: the options, then the sandbox's main command. */
function splitCommand(argv: readonly string[]): [string[], string[]] {
  const at = argv.indexOf("--");
  return at === -1 ? [[...argv], []] : [argv.slice(0, at), argv.slice(at + 1)];
}

/** `cops openshell create <name> …`; exit 0 (created, or printed with --dry-run), 1, 2. */
export async function runOpenShellCreate(argv: readonly string[], io: Io): Promise<number> {
  const [args, command] = splitCommand(argv);
  const parsed = parse(args, CREATE_OPTIONS);
  if (!parsed.ok || parsed.positionals.length !== 1) {
    io.err(
      `cops openshell create: ${parsed.ok ? "expected exactly one sandbox name" : parsed.error}`,
    );
    return EXIT.usage;
  }
  const v = parsed.values;
  const compiled = await compileFor(v, io, "create");
  if (typeof compiled === "number") return compiled;
  if (compiled.yaml === null) return EXIT.failed;
  const policyFile = writePolicy(
    compiled.yaml,
    typeof v["policy-out"] === "string" ? v["policy-out"] : null,
  );
  const options: CreateOptions = {
    name: parsed.positionals[0] ?? "",
    from: typeof v.from === "string" ? v.from : null,
    policyFile,
    providers: list(v, "provider"),
    env: list(v, "env"),
    command,
  };
  io.out(`policy: ${policyFile}`);
  for (const line of planned(options))
    io.out(`${v["dry-run"] === true ? "would run" : "run"}: ${line}`);
  return v["dry-run"] === true ? EXIT.ok : create(v, options, io);
}

/** Runs the planned calls when `openshell` is found. */
async function create(v: Values, options: CreateOptions, io: Io): Promise<number> {
  const binary = openShellBinary(v);
  if (binary === null) {
    io.err(
      "cops openshell create: openshell not found on PATH (pass --openshell path): nothing created",
    );
    return EXIT.failed;
  }
  const cli = openShellCli({ binary, home: process.env.HOME ?? "/nonexistent" });
  if (!cli.ok) {
    io.err(`cops openshell create: ${cli.error}`);
    return EXIT.failed;
  }
  const made = await sandboxCreate(cli.value, options);
  if (!made.ok) {
    io.err(`cops openshell create: ${made.error}`);
    return EXIT.failed;
  }
  io.out(
    `created ${made.value.name}: phase ${made.value.phase}, policy revision ${made.value.policyVersion}`,
  );
  return EXIT.ok;
}
