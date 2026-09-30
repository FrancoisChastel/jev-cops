/**
 * `cops keygen [--rotate] [--config path] [--admin-socket path] [--json]` (D-104): the
 * Ed25519 key copsd signs audit checkpoints with. The private key goes to `[audit] key`
 * (0600, 0700 directory, never overwritten), the public key to `[audit] public_key` for the
 * cyber team. `--rotate` leaves the next key pending next to the current one and asks a
 * running copsd, on its admin socket, to switch now: copsd writes a rotation checkpoint
 * signed by the old key naming the new one. Without a running copsd it switches at its
 * next start. Exit 0 done, 1 refused or failed, 2 usage.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type AuditConfig,
  ConfigError,
  generateAuditKey,
  loadConfig,
  pendingKeyPath,
  writeKeyPair,
  writePrivateKey,
  writePublicKey,
} from "@jev-cops/daemon";
import { EXIT, type Io } from "../io.ts";

/** Where keygen looks: the home `~` expands to, the working directory, the environment. */
export interface KeygenDeps {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const PROCESS_DEPS: KeygenDeps = { home: homedir(), cwd: process.cwd(), env: process.env };
const ROTATE_TIMEOUT_MS = 5_000;

interface Parsed {
  readonly rotate: boolean;
  readonly json: boolean;
  readonly config?: string;
  readonly adminSocket?: string;
}

function parse(argv: readonly string[]): Parsed | string {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        rotate: { type: "boolean" },
        json: { type: "boolean" },
        config: { type: "string" },
        "admin-socket": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) return `unexpected argument "${positionals[0]}"`;
    return {
      rotate: values.rotate === true,
      json: values.json === true,
      ...(values.config === undefined ? {} : { config: values.config }),
      ...(values["admin-socket"] === undefined ? {} : { adminSocket: values["admin-socket"] }),
    };
  } catch (cause) {
    return (cause as Error).message;
  }
}

/** A result to print: text lines, or the JSON body. */
interface Outcome {
  readonly code: number;
  readonly lines: readonly string[];
  readonly json: Record<string, unknown>;
}

function created(cfg: AuditConfig): Outcome {
  if (existsSync(cfg.key)) {
    const msg = `a key exists at ${cfg.key}: use --rotate to replace it (never overwritten)`;
    return { code: EXIT.failed, lines: [msg], json: { error: msg } };
  }
  const pair = generateAuditKey();
  writeKeyPair(pair, cfg.key, cfg.publicKey);
  return {
    code: EXIT.ok,
    lines: [
      `audit signing key ${pair.keyId} written`,
      `  private key  ${cfg.key} (0600; never share it, never copy it into a sandbox)`,
      `  public key   ${cfg.publicKey} (hand it to the cyber team; cops doctor verifies with it)`,
      "copsd signs audit checkpoints with it from its next start.",
    ],
    json: { key_id: pair.keyId, key: cfg.key, public_key: cfg.publicKey, rotation: null },
  };
}

/** Asks a running copsd to switch to the pending key; null when it cannot be reached. */
async function rotateLive(adminSocket: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch("http://localhost/v1/audit/rotate", {
      method: "POST",
      unix: adminSocket,
      body: "{}",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(ROTATE_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

function refused(msg: string): Outcome {
  return { code: EXIT.failed, lines: [msg], json: { error: msg } };
}

async function rotated(cfg: AuditConfig, adminSocket: string): Promise<Outcome> {
  const pending = pendingKeyPath(cfg.key);
  if (!existsSync(cfg.key)) return refused(`no key to rotate from at ${cfg.key}: run cops keygen`);
  if (existsSync(pending)) return refused(`a rotation is already pending at ${pending}`);
  const pair = generateAuditKey();
  writePrivateKey(pending, pair.privatePem);
  const pub = join(dirname(cfg.publicKey), `audit-ed25519.${pair.keyId}.pub`);
  writePublicKey(pub, pair.publicPem);
  const live = await rotateLive(adminSocket);
  const head = [`next audit signing key ${pair.keyId} written`, `  public key   ${pub}`];
  const json = { key_id: pair.keyId, key: pending, public_key: pub };
  if (live?.status === 200) {
    const seq = (live.body as { rotation_seq?: unknown } | null)?.rotation_seq;
    const line = `rotated: copsd signed the rotation (seq ${String(seq)}) with the old key and signs with ${pair.keyId} now`;
    return { code: EXIT.ok, lines: [...head, line], json: { ...json, rotation: "applied" } };
  }
  const why = live === null ? "copsd is not reachable" : `copsd answered ${live.status}`;
  const line = `${why}: it switches to this key at its next start, with a rotation checkpoint signed by the old key`;
  return { code: EXIT.ok, lines: [...head, line], json: { ...json, rotation: "pending" } };
}

/** Runs `cops keygen`; resolves with the exit code. */
export async function runKeygenCommand(
  argv: readonly string[],
  io: Io,
  deps: KeygenDeps = PROCESS_DEPS,
): Promise<number> {
  const args = parse(argv);
  if (typeof args === "string") {
    io.err(`cops keygen: ${args}`);
    return EXIT.usage;
  }
  let config: ReturnType<typeof loadConfig>["config"];
  try {
    const configPath =
      args.config === undefined ? {} : { configPath: resolve(deps.cwd, args.config) };
    config = loadConfig({ ...configPath, home: deps.home, cwd: deps.cwd, env: deps.env }).config;
  } catch (cause) {
    if (!(cause instanceof ConfigError)) throw cause;
    io.err(`cops keygen: ${cause.message}`);
    return EXIT.failed;
  }
  const admin = args.adminSocket ?? config.daemon.adminSocket;
  const out = args.rotate ? await rotated(config.audit, admin) : created(config.audit);
  if (args.json) io.out(JSON.stringify(out.json, null, 2));
  else for (const line of out.lines) (out.code === EXIT.ok ? io.out : io.err)(`${line}`);
  return out.code;
}
