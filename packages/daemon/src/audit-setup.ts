import { AuditLog } from "./audit.ts";
import { FileTransport } from "./audit-forward/file.ts";
import { CursorForwarder, type ForwarderOptions } from "./audit-forward/forwarder.ts";
import { forwardingBehind } from "./audit-forward/gate.ts";
import { SyslogTransport } from "./audit-forward/syslog.ts";
import type { AuditForwarder, ForwarderStatus } from "./audit-forward/types.ts";
import { applyRotation, keyMismatch, loadSigning } from "./audit-sign/boot.ts";
import type { AuditConfig, AuditForward, DaemonConfig } from "./config.ts";

/**
 * The daemon's audit wiring: the forwarder `[audit.forward]` names, the log opened with it,
 * what `/v1/health` reports about both, and an orderly close.
 */

/** What the runtime holds for auditing. */
export interface AuditRuntime {
  readonly audit: AuditLog;
  readonly forwarder: AuditForwarder | null;
  readonly warnings: readonly string[];
}

/** Test and embedding hooks for the forwarder. */
export interface ForwardDeps {
  readonly now: () => number;
  readonly retry?: ForwarderOptions["retry"];
}

/** The forwarder for `[audit.forward]`; null when none is configured. */
export function buildForwarder(
  fwd: AuditForward | null,
  logPath: string,
  deps: ForwardDeps,
): AuditForwarder | null {
  if (fwd === null) return null;
  const opts = {
    logPath,
    cursorPath: fwd.cursor,
    now: deps.now,
    ...(deps.retry === undefined ? {} : { retry: deps.retry }),
  };
  const transport =
    fwd.syslog === null ? new FileTransport(fwd.target) : new SyslogTransport(fwd.syslog);
  return new CursorForwarder(transport, opts);
}

/** The boot warning when the audit log stays on this machine. */
function forwardWarning(fwd: AuditForward | null): string[] {
  if (fwd !== null) return [];
  return [
    "audit log not shipped off-box ([audit.forward] unset): a tail cut at a checkpoint is invisible locally",
  ];
}

/**
 * Opens the audit log with its signing key and forwarder (D-103, D-104). A pending key
 * rotation is applied here; a signing key that is not the one the log put in force is an
 * `anomaly` line and a warning. Throws under `require_signing`
 * without a usable key, before anything is opened.
 */
export function openAudit(config: DaemonConfig, deps: ForwardDeps): AuditRuntime {
  const cfg = config.audit;
  const keys = loadSigning(cfg);
  const forwarder = buildForwarder(cfg.forward, cfg.path, deps);
  const signing = { signer: keys.signer, every: cfg.checkpointEvery };
  const audit = AuditLog.open(cfg.path, { now: deps.now, forwarder, signing });
  if (keys.pending !== null) applyRotation(audit, cfg.key, keys.pending);
  const mismatch = keyMismatch(audit);
  if (mismatch !== null) audit.append({ kind: "anomaly", payload: { reason: mismatch } });
  const warnings = [...keys.warnings, ...forwardWarning(cfg.forward)];
  return { audit, forwarder, warnings: mismatch === null ? warnings : [...warnings, mismatch] };
}

/** Closes the log, then lets the forwarder ship what it can within its budget. */
export async function closeAudit(rt: AuditRuntime): Promise<void> {
  rt.audit.close();
  await rt.forwarder?.close();
}

/**
 * The `audit` block of `/v1/health`: the head, signing (key, key in force, interval, last
 * checkpoint) and the forwarder's state (never its target).
 */
export function auditHealth(audit: AuditLog, forwarder: AuditForwarder | null, cfg: AuditConfig) {
  const status: ForwarderStatus | null = forwarder?.status() ?? null;
  const forward = cfg.forward;
  const s = audit.signing();
  return {
    head_seq: audit.head().seq,
    signing: {
      key_id: s.keyId,
      in_force: s.inForce,
      checkpoint_every: s.every,
      last_checkpoint_seq: s.lastCheckpointSeq,
      required: cfg.requireSigning,
    },
    forward:
      status === null || forward === null
        ? null
        : {
            kind: status.kind,
            connected: status.connected,
            sent_seq: status.sentSeq,
            lag_lines: status.lagLines,
            lag_ms: status.lagMs,
            last_error: status.lastError,
            down_since: status.downSince,
            required: forward.required,
            refusing: forwardingBehind(forward, status) !== null,
          },
  };
}
