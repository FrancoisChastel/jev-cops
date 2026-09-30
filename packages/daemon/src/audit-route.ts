import { applyRotation } from "./audit-sign/boot.ts";
import { loadSigner, pendingKeyPath } from "./audit-sign/keys.ts";
import type { Runtime } from "./daemon.ts";
import type { Reply } from "./service.ts";

/**
 * `POST /v1/audit/rotate` (admin socket only, D-104): switches copsd to the key `cops
 * keygen --rotate` left pending, after a rotation checkpoint signed by the current key that
 * names it. 404 when no rotation is pending, 400 when the pending key is unusable, 409 when
 * copsd runs unsigned (there is no key to announce the new one with: restart it instead).
 */
export function handleAuditRotate(rt: Runtime): Reply {
  const pending = loadSigner(pendingKeyPath(rt.config.audit.key));
  if (!pending.ok) return { status: pending.missing ? 404 : 400, body: { error: pending.error } };
  if (rt.audit.signing().keyId === null) {
    const error = "copsd runs unsigned: restart it to start signing with the new key";
    return { status: 409, body: { error } };
  }
  const line = applyRotation(rt.audit, rt.config.audit.key, pending.signer);
  rt.log.log("info", "audit signing key rotated", { key_id: pending.signer.keyId });
  const body = { ok: true, key_id: pending.signer.keyId, rotation_seq: line?.seq ?? null };
  return { status: 200, body };
}
