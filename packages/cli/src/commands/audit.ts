/**
 * `cops audit verify <local.jsonl> --pubkey <file> [--pubkey <file>…] [--remote <copy>]
 * [--json]` (D-104): verifies an audit log without the daemon — the hash chain, every
 * checkpoint signature under the key in force (following in-chain rotations from the
 * given root keys), the unsigned tail after the last checkpoint — and, with `--remote`,
 * that the local log and the off-box copy (our JSONL, RFC 5424 messages one per line, or a
 * raw RFC 5425 capture) agree: a longer copy means the local tail was cut. Exit 0
 * verified (warnings included), 1 failed or unreadable input, 2 usage.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  compareCopies,
  loadPublicKey,
  type PublicKeyInfo,
  readRemoteCopy,
  verifyAuditLines,
} from "@jev-cops/daemon";
import { EXIT, type Io } from "../io.ts";
import { auditReport, renderAuditReport } from "./audit-report.ts";

const OPTIONS = {
  pubkey: { type: "string", multiple: true },
  remote: { type: "string" },
  json: { type: "boolean" },
} as const;

interface VerifyArgs {
  readonly path: string;
  readonly pubkeys: readonly string[];
  readonly remote: string | null;
  readonly json: boolean;
}

function parseVerify(argv: readonly string[]): VerifyArgs | string {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (cause) {
    return (cause as Error).message;
  }
  const [path, ...extra] = parsed.positionals;
  if (path === undefined || extra.length > 0) return "expected exactly one audit log";
  const pubkeys = parsed.values.pubkey ?? [];
  if (pubkeys.length === 0) return "--pubkey <file> is required (the public key the team holds)";
  return { path, pubkeys, remote: parsed.values.remote ?? null, json: parsed.values.json === true };
}

function loadKeys(paths: readonly string[]): PublicKeyInfo[] | string {
  const keys: PublicKeyInfo[] = [];
  for (const path of paths) {
    const loaded = loadPublicKey(path);
    if (!loaded.ok) return loaded.error;
    keys.push(loaded.key);
  }
  return keys;
}

function readTexts(path: string): string[] | string {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((t) => t !== "");
  } catch (cause) {
    return `cannot read ${path}: ${(cause as Error).message}`;
  }
}

/** Runs the verification; a string is why it could not run (unreadable input). */
function verify(a: VerifyArgs): ReturnType<typeof auditReport> | string {
  const keys = loadKeys(a.pubkeys);
  if (typeof keys === "string") return keys;
  const texts = readTexts(a.path);
  if (typeof texts === "string") return texts;
  const local = verifyAuditLines(texts, { keys });
  if (a.remote === null) return auditReport(a.path, local, null);
  let copy: ReturnType<typeof readRemoteCopy>;
  try {
    copy = readRemoteCopy(a.remote);
  } catch (cause) {
    return `cannot read ${a.remote}: ${(cause as Error).message}`;
  }
  return auditReport(a.path, local, { path: a.remote, c: compareCopies(texts, copy, { keys }) });
}

async function runVerify(argv: readonly string[], io: Io): Promise<number> {
  const args = parseVerify(argv);
  if (typeof args === "string") {
    io.err(`cops audit verify: ${args}`);
    return EXIT.usage;
  }
  const report = verify(args);
  if (typeof report === "string") {
    io.err(`cops audit verify: ${report}`);
    return EXIT.failed;
  }
  if (args.json) io.out(JSON.stringify(report, null, 2));
  else for (const line of renderAuditReport(report)) io.out(line);
  return report.ok ? EXIT.ok : EXIT.failed;
}

/** `cops audit <subcommand>`: `verify` only. */
export async function runAuditCommand(argv: readonly string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "verify") return runVerify(rest, io);
  io.err(
    "cops audit: expected `cops audit verify <local.jsonl> --pubkey <file> [--remote <copy>] [--json]`",
  );
  return EXIT.usage;
}
