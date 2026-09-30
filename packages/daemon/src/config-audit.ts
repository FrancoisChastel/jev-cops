import { dirname, join } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import { z } from "zod";
import { isTable, type Table } from "./config-rules.ts";

/**
 * The `[audit]` table of `cops.toml` (D-103, D-104): the local log, its checkpoint key and
 * interval, and `[audit.forward]`, the off-box destination. None of it may be set by a
 * repo override except turning `require_signing` or `forward.required` on (config-rules).
 */

/** Syslog facilities by name (RFC 5424 §6.2.1). */
export const SYSLOG_FACILITIES: Readonly<Record<string, number>> = {
  kern: 0,
  user: 1,
  daemon: 3,
  auth: 4,
  syslog: 5,
  authpriv: 10,
  audit: 13,
  local0: 16,
  local1: 17,
  local2: 18,
  local3: 19,
  local4: 20,
  local5: 21,
  local6: 22,
  local7: 23,
};

/** RFC 5425 §4.3.1: receivers MUST take 2048 octets and SHOULD take 8192 (rsyslog's default). */
export const MIN_MESSAGE_BYTES = 2_048;
export const DEFAULT_MESSAGE_BYTES = 8_192;
const MAX_MESSAGE_BYTES = 1_048_576;
/** The example private enterprise number of RFC 5424 §7.2.2, until the team registers one. */
export const DEFAULT_ENTERPRISE_NUMBER = 32_473;

/** How the `syslog` forwarder reaches its receiver (TLS only, server verified against `ca`). */
export interface SyslogSettings {
  readonly host: string;
  readonly port: number;
  /** The CA (or pinned self-signed certificate) the receiver's certificate must chain to. */
  readonly ca: string;
  /** Optional client certificate and key (PEM) for a receiver that asks for one. */
  readonly cert: string | null;
  readonly key: string | null;
  /** SNI and the name checked in the certificate; default the host. */
  readonly serverName: string | null;
  readonly facility: number;
  readonly appName: string;
  readonly enterpriseNumber: number;
  /** Largest SYSLOG-MSG sent; longer lines are split into parts. */
  readonly maxMessageBytes: number;
  /** Lines resent before the cursor after an unclean stop (syslog has no acknowledgement). */
  readonly resendOverlap: number;
}

/** `[audit.forward]`, resolved. */
export interface AuditForward {
  readonly kind: "file" | "syslog";
  /** A file path (`file`) or `host:port` (`syslog`). */
  readonly target: string;
  /** Fail closed: past the lag limits `/v1/judge` refuses deny-class calls (503). */
  readonly required: boolean;
  readonly maxLagLines: number;
  readonly maxLagMs: number;
  /** Where the forward cursor is persisted (a private path). */
  readonly cursor: string;
  readonly syslog: SyslogSettings | null;
}

/** `[audit]`, resolved: absolute paths, defaults filled in. */
export interface AuditConfig {
  readonly path: string;
  readonly forward: AuditForward | null;
  /** A signed checkpoint every this many lines (D-104). */
  readonly checkpointEvery: number;
  /** Refuse to start without a usable signing key. */
  readonly requireSigning: boolean;
  /** The Ed25519 private key (PKCS #8 PEM, 0600). */
  readonly key: string;
  /** The public key handed to the cyber team; `cops doctor` verifies with it. */
  readonly publicKey: string;
}

const text = z.string().min(1);

/** The `[audit]` table of one file. Strict: unknown keys are errors. */
export const auditFileSchema = z.strictObject({
  path: text.optional(),
  checkpoint_every: z.int().positive().max(1_000_000).optional(),
  require_signing: z.boolean().optional(),
  key: text.optional(),
  public_key: text.optional(),
  forward: z
    .strictObject({
      kind: z.enum(["syslog", "file"]).optional(),
      target: text.optional(),
      required: z.boolean().optional(),
      max_lag_lines: z.int().positive().optional(),
      max_lag_ms: z.int().positive().optional(),
      cursor: text.optional(),
      ca_file: text.optional(),
      cert_file: text.optional(),
      key_file: text.optional(),
      server_name: text.optional(),
      facility: z.enum(Object.keys(SYSLOG_FACILITIES) as [string, ...string[]]).optional(),
      app_name: z
        .string()
        .regex(/^[!-~]{1,48}$/)
        .optional(),
      enterprise_number: z.int().positive().optional(),
      max_message_bytes: z.int().min(MIN_MESSAGE_BYTES).max(MAX_MESSAGE_BYTES).optional(),
    })
    .optional(),
});
type AuditFile = z.output<typeof auditFileSchema>;
type ForwardFile = NonNullable<AuditFile["forward"]>;

/** The defaults of `[audit]` (paths `~`-relative). */
export const DEFAULT_AUDIT_TABLE: Table = {
  path: "~/.jev-cops/audit.jsonl",
  checkpoint_every: 100,
  require_signing: false,
  key: "~/.jev-cops/keys/audit-ed25519.key",
  public_key: "~/.config/jev-cops/audit-ed25519.pub",
};

const HOST_PORT = /^(?:\[([^\]]+)\]|([^:/\s]+)):(\d+)$/;
const MAX_PORT = 65_535;

/** Parses `host:port` (IPv6 as `[addr]:port`), port 1 to 65535. */
export function parseHostPort(target: string): Result<{ host: string; port: number }, string> {
  const m = HOST_PORT.exec(target.trim());
  const port = Number(m?.[3]);
  if (m === null || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return err(`audit.forward.target must be "host:port" for syslog, got "${target}"`);
  }
  return ok({ host: m[1] ?? m[2] ?? "", port });
}

const FORWARD_PATHS = ["cursor", "ca_file", "cert_file", "key_file"] as const;

/**
 * `[audit]` of one file with its paths resolved by `expand` (against that file's
 * directory): the key files, the forward cursor and TLS files, and a `file` target (a
 * target that is not `host:port` when the file names no kind).
 */
export function resolveAuditPaths(audit: Table, expand: (p: string) => string): Table {
  let out: Record<string, unknown> = { ...audit };
  for (const key of ["path", "key", "public_key"] as const) {
    if (typeof out[key] === "string") out = { ...out, [key]: expand(out[key] as string) };
  }
  if (!isTable(out.forward)) return out;
  let fwd: Record<string, unknown> = { ...out.forward };
  for (const key of FORWARD_PATHS) {
    if (typeof fwd[key] === "string") fwd = { ...fwd, [key]: expand(fwd[key] as string) };
  }
  const target = fwd.target;
  const isFile =
    fwd.kind === "file" ||
    (fwd.kind === undefined && typeof target === "string" && !HOST_PORT.test(target));
  if (typeof target === "string" && isFile) fwd = { ...fwd, target: expand(target) };
  return { ...out, forward: fwd };
}

function syslogSettings(f: ForwardFile, target: string): Result<SyslogSettings, string> {
  const hp = parseHostPort(target);
  if (!hp.ok) return hp;
  if (f.ca_file === undefined) {
    return err(
      "audit.forward.ca_file is required for syslog: the receiver's certificate is verified against it",
    );
  }
  return ok({
    ...hp.value,
    ca: f.ca_file,
    cert: f.cert_file ?? null,
    key: f.key_file ?? null,
    serverName: f.server_name ?? null,
    facility: SYSLOG_FACILITIES[f.facility ?? "local0"] ?? 16,
    appName: f.app_name ?? "copsd",
    enterpriseNumber: f.enterprise_number ?? DEFAULT_ENTERPRISE_NUMBER,
    maxMessageBytes: f.max_message_bytes ?? DEFAULT_MESSAGE_BYTES,
    resendOverlap: 100,
  });
}

function forwardConfig(
  f: ForwardFile | undefined,
  auditPath: string,
): Result<AuditForward | null, string> {
  if (f === undefined) return ok(null);
  if (f.kind === undefined || f.target === undefined) {
    return err(
      "audit.forward needs kind (file or syslog) and target; forwarding cannot be required without them",
    );
  }
  const syslog = f.kind === "syslog" ? syslogSettings(f, f.target) : ok(null);
  if (!syslog.ok) return syslog;
  return ok({
    kind: f.kind,
    target: f.target,
    required: f.required ?? false,
    maxLagLines: f.max_lag_lines ?? 1_000,
    maxLagMs: f.max_lag_ms ?? 60_000,
    cursor: f.cursor ?? join(dirname(auditPath), "forward.cursor"),
    syslog: syslog.value,
  });
}

/** The resolved `[audit]` of the merged configuration, or why it is invalid. */
export function auditConfig(t: AuditFile | undefined): Result<AuditConfig, string> {
  const path = t?.path ?? "";
  const forward = forwardConfig(t?.forward, path);
  if (!forward.ok) return forward;
  return ok({
    path,
    forward: forward.value,
    checkpointEvery: t?.checkpoint_every ?? 100,
    requireSigning: t?.require_signing ?? false,
    key: t?.key ?? "",
    publicKey: t?.public_key ?? "",
  });
}
