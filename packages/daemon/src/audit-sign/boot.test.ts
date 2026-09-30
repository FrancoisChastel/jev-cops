import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditConfig } from "../config-audit.ts";
import { testKey } from "../testing/signed-log.ts";
import { loadSigning } from "./boot.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-boot-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(over: Partial<AuditConfig> = {}): AuditConfig {
  return {
    path: join(dir, "audit.jsonl"),
    forward: null,
    checkpointEvery: 100,
    requireSigning: false,
    key: join(dir, "audit.key"),
    publicKey: join(dir, "audit.pub"),
    ...over,
  };
}

describe("loadSigning", () => {
  test("a pending key with no current one is promoted, with nothing to announce", () => {
    const next = testKey();
    writeFileSync(`${cfg().key}.next`, next.privatePem, { mode: 0o600 });
    const s = loadSigning(cfg());
    expect(s.signer?.keyId).toBe(next.pub.keyId);
    expect(s.pending).toBeNull();
    expect(existsSync(`${cfg().key}.next`)).toBe(false);
  });

  test("an unusable pending key is ignored with a warning", () => {
    writeFileSync(cfg().key, testKey().privatePem, { mode: 0o600 });
    writeFileSync(`${cfg().key}.next`, "garbage", { mode: 0o600 });
    const s = loadSigning(cfg());
    expect(s.pending).toBeNull();
    expect(s.warnings.join(" ")).toContain("pending key rotation ignored");
  });

  test("an unusable current key: a warning, or no start under require_signing", () => {
    writeFileSync(cfg().key, testKey().privatePem, { mode: 0o644 });
    expect(loadSigning(cfg()).warnings.join(" ")).toContain("mode 0644");
    expect(() => loadSigning(cfg({ requireSigning: true }))).toThrow(/require_signing = true/);
  });
});
