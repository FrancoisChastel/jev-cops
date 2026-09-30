import { AuditLog } from "./audit.ts";
import { FileTransport } from "./audit-forward/file.ts";
import { CursorForwarder, type ForwarderOptions } from "./audit-forward/forwarder.ts";
import { SyslogTransport } from "./audit-forward/syslog.ts";
import type { AuditForwarder, ForwarderStatus } from "./audit-forward/types.ts";
import type { AuditForward, DaemonConfig } from "./config.ts";

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

/** Opens the audit log with its forwarder. */
export function openAudit(config: DaemonConfig, deps: ForwardDeps): AuditRuntime {
  const fwd = config.audit.forward;
  const forwarder = buildForwarder(fwd, config.audit.path, deps);
  const audit = AuditLog.open(config.audit.path, { now: deps.now, forwarder });
  return { audit, forwarder, warnings: forwardWarning(fwd) };
}

/** Closes the log, then lets the forwarder ship what it can within its budget. */
export async function closeAudit(rt: AuditRuntime): Promise<void> {
  rt.audit.close();
  await rt.forwarder?.close();
}

/** The `audit` block of `/v1/health`: the head, and the forwarder's state (no target). */
export function auditHealth(
  audit: AuditLog,
  forwarder: AuditForwarder | null,
  forward: AuditForward | null,
) {
  const status: ForwarderStatus | null = forwarder?.status() ?? null;
  return {
    head_seq: audit.head().seq,
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
          },
  };
}
