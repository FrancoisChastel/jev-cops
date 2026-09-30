import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recompute, signedLog, testKey } from "../../../daemon/src/testing/signed-log.ts";
import {
  AUDIT_GUARANTEE,
  type AuditDoctorInput,
  type AuditHealth,
  auditChecks,
} from "./doctor-audit.ts";
import type { Check } from "./doctor-types.ts";

let dir: string;
const key = testKey();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jvda-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string, mode = 0o644): string {
  const path = join(dir, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

const lines = (texts: readonly string[]) => `${texts.join("\n")}\n`;

function health(over: Partial<AuditHealth> = {}): AuditHealth {
  return {
    head_seq: 9,
    signing: {
      key_id: key.pub.keyId,
      in_force: key.pub.keyId,
      checkpoint_every: 3,
      last_checkpoint_seq: 8,
      required: false,
    },
    forward: {
      kind: "syslog",
      connected: true,
      sent_seq: 9,
      lag_lines: 0,
      lag_ms: 0,
      last_error: null,
      required: false,
      refusing: false,
    },
    ...over,
  };
}

function input(over: Partial<AuditDoctorInput> = {}): AuditDoctorInput {
  return {
    path: over.path ?? write("default.jsonl", lines(signedLog(key, 7, 3))),
    keyPath: over.keyPath ?? write("audit.key", key.privatePem, 0o600),
    publicKey: over.publicKey ?? write("audit.pub", key.publicPem),
    requireSigning: false,
    remote: null,
    health: health(),
    ...over,
  };
}

const byName = (checks: readonly Check[], name: string) => checks.find((c) => c.name === name);

describe("doctor: audit (T12, D-103, D-104)", () => {
  test("a signed, forwarded log: every check ok and the guarantee printed", () => {
    const checks = auditChecks(input());
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["chain", "ok"],
      ["signatures", "ok"],
      ["signing key", "ok"],
      ["forwarding", "ok"],
    ]);
    expect(byName(checks, "signatures")?.detail).toContain("signed through seq 7");
    expect(byName(checks, "signatures")?.detail).toContain(AUDIT_GUARANTEE);
    expect(AUDIT_GUARANTEE).toContain("off-box copy");
  });

  test("a full recompute fails the signatures (exit 1 in doctor)", () => {
    const path = write("audit.jsonl", lines(recompute(signedLog(key, 7, 3), 2, { i: 5 })));
    const checks = auditChecks(input({ path }));
    expect(byName(checks, "chain")?.status).toBe("ok");
    expect(byName(checks, "signatures")?.status).toBe("fail");
  });

  test("an edited line fails the chain", () => {
    const texts = signedLog(key, 4, 3);
    texts[1] = (texts[1] ?? "").replace('"i":1', '"i":3');
    const checks = auditChecks(input({ path: write("audit.jsonl", lines(texts)) }));
    expect(byName(checks, "chain")).toMatchObject({ status: "fail" });
    expect(byName(checks, "chain")?.detail).toContain("broken at seq 2");
  });

  test("no log yet, no public key: warnings", () => {
    const checks = auditChecks(
      input({ path: join(dir, "none.jsonl"), publicKey: join(dir, "none.pub") }),
    );
    expect(byName(checks, "chain")?.status).toBe("warn");
    expect(byName(checks, "signatures")).toMatchObject({ status: "warn" });
    expect(byName(checks, "signatures")?.detail).toContain("cops keygen");
  });

  test("no signing key: a warning, a failure when signing is required", () => {
    const missing = {
      keyPath: join(dir, "none.key"),
      health: health({ signing: { ...health().signing, key_id: null } }),
    };
    expect(byName(auditChecks(input(missing)), "signing key")?.status).toBe("warn");
    const required = auditChecks(input({ ...missing, requireSigning: true }));
    expect(byName(required, "signing key")?.status).toBe("fail");
  });

  test("a key others can read fails; copsd signing with another key warns", () => {
    const loose = auditChecks(input({ keyPath: write("loose.key", key.privatePem, 0o644) }));
    expect(byName(loose, "signing key")?.status).toBe("fail");
    const other = testKey();
    const stale = auditChecks(
      input({ health: health({ signing: { ...health().signing, key_id: other.pub.keyId } }) }),
    );
    expect(byName(stale, "signing key")?.status).toBe("warn");
    expect(byName(stale, "signing key")?.detail).toContain("restart copsd");
  });

  test("forwarding: not configured warns, a long lag warns, required and behind fails", () => {
    const none = auditChecks(input({ health: health({ forward: null }) }));
    expect(byName(none, "forwarding")).toMatchObject({ status: "warn" });
    expect(byName(none, "forwarding")?.detail).toContain("not shipped off-box");
    const fwd = health().forward;
    if (fwd === null) throw new Error("unreachable");
    const lagging = {
      ...fwd,
      connected: false,
      lag_lines: 40,
      lag_ms: 120_000,
      last_error: "ECONNREFUSED",
    };
    const lag = auditChecks(input({ health: health({ forward: lagging }) }));
    expect(byName(lag, "forwarding")).toMatchObject({ status: "warn" });
    expect(byName(lag, "forwarding")?.detail).toContain("ECONNREFUSED");
    const refusing = { ...lagging, required: true, refusing: true };
    expect(
      byName(auditChecks(input({ health: health({ forward: refusing }) })), "forwarding")?.status,
    ).toBe("fail");
    const short = { ...fwd, lag_lines: 2, lag_ms: 500 };
    expect(
      byName(auditChecks(input({ health: health({ forward: short }) })), "forwarding")?.status,
    ).toBe("ok");
    expect(byName(auditChecks(input({ health: null })), "forwarding")?.status).toBe("warn");
  });

  test("--audit-remote: truncation against the off-box copy fails, agreement names its last seq", () => {
    const texts = signedLog(key, 7, 3);
    const remote = write("copy.jsonl", lines(texts));
    const cut = auditChecks(input({ path: write("cut.jsonl", lines(texts.slice(0, 4))), remote }));
    expect(byName(cut, "off-box copy")?.status).toBe("fail");
    expect(byName(cut, "off-box copy")?.detail).toContain("local tail truncated after seq 4");
    const same = auditChecks(input({ path: write("same.jsonl", lines(texts)), remote }));
    expect(byName(same, "off-box copy")).toMatchObject({ status: "ok" });
    expect(byName(same, "off-box copy")?.detail).toContain("last seq 9");
    const unreadable = auditChecks(input({ remote: join(dir, "nope") }));
    expect(byName(unreadable, "off-box copy")?.status).toBe("fail");
  });

  test("an unusable public key fails", () => {
    const checks = auditChecks(input({ publicKey: write("bad.pub", "not a key") }));
    expect(byName(checks, "signatures")?.status).toBe("fail");
  });
});
