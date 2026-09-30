import { existsSync, renameSync } from "node:fs";
import type { AuditLog } from "../audit.ts";
import type { AuditLine } from "../audit-line.ts";
import type { AuditConfig } from "../config-audit.ts";
import { type CheckpointSigner, loadSigner, pendingKeyPath } from "./keys.ts";

/**
 * The daemon's signing key at boot (D-104): the key at `[audit] key`, a rotation `cops
 * keygen --rotate` left pending next to it, and `[audit] require_signing`. Without a key
 * copsd warns loudly and runs unsigned; with `require_signing = true` it refuses to start.
 */

/** The keys found at boot and what to warn about. */
export interface SigningSetup {
  readonly signer: CheckpointSigner | null;
  /** The key a rotation is waiting to switch to; null when none. */
  readonly pending: CheckpointSigner | null;
  readonly warnings: readonly string[];
}

/**
 * Loads the signing key. A pending key with no current one is simply promoted (there is
 * no old key to announce it). Throws under `require_signing` without a usable key: copsd
 * does not start.
 */
export function loadSigning(cfg: AuditConfig): SigningSetup {
  const pendingPath = pendingKeyPath(cfg.key);
  if (!existsSync(cfg.key) && existsSync(pendingPath)) renameSync(pendingPath, cfg.key);
  const current = loadSigner(cfg.key);
  const pending = existsSync(pendingPath) ? loadSigner(pendingPath) : null;
  const warnings: string[] = [];
  if (!current.ok) {
    const why = current.missing ? `${current.error}: run \`cops keygen\`` : current.error;
    if (cfg.requireSigning) {
      throw new Error(`[audit] require_signing = true and ${why}`);
    }
    warnings.push(
      `audit checkpoints unsigned (${why}); tail truncation and a full recompute go undetected locally`,
    );
  }
  if (pending !== null && !pending.ok)
    warnings.push(`pending key rotation ignored: ${pending.error}`);
  return {
    signer: current.ok ? current.signer : null,
    pending: pending?.ok === true && current.ok ? pending.signer : null,
    warnings,
  };
}

/**
 * Switches to the pending key: a rotation checkpoint signed by the current key naming it,
 * then the pending file replaces the key file. If the log already names it (a crash
 * between the two steps), only the file moves and the log adopts the key. Returns the
 * rotation line, or null when none was needed.
 */
export function applyRotation(
  audit: AuditLog,
  keyPath: string,
  next: CheckpointSigner,
): AuditLine | null {
  const already = audit.signing().inForce === next.keyId;
  const line = already ? null : audit.rotate(next);
  if (already) audit.adoptKey(next);
  renameSync(pendingKeyPath(keyPath), keyPath);
  return line;
}

/** Why the signing key is not the one the log's checkpoints put in force, or null. */
export function keyMismatch(audit: AuditLog): string | null {
  const s = audit.signing();
  if (s.keyId === null || s.inForce === null || s.keyId === s.inForce) return null;
  return `the signing key ${s.keyId} is not the key in force in the audit log (${s.inForce}) and no rotation names it: verifiers will reject its checkpoints; restore the key, or rotate with \`cops keygen --rotate\` while the old key is in place`;
}
