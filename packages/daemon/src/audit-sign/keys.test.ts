import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateAuditKey,
  keyIdOf,
  loadPublicKey,
  loadSigner,
  pendingKeyPath,
  writeKeyPair,
} from "./keys.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-keys-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const paths = () => ({
  key: join(dir, "keys", "audit-ed25519.key"),
  pub: join(dir, "pub", "a.pub"),
});

describe("generateAuditKey", () => {
  test("an Ed25519 pair whose key id is the first 16 hex of SHA-256 of the raw public key", () => {
    const k = generateAuditKey();
    expect(k.privatePem).toContain("BEGIN PRIVATE KEY");
    expect(k.publicPem).toContain("BEGIN PUBLIC KEY");
    expect(k.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(k.publicPem)).toBe(k.keyId);
    expect(generateAuditKey().keyId).not.toBe(k.keyId);
  });
});

describe("writeKeyPair / loadSigner / loadPublicKey", () => {
  test("files are private (0600 in a 0700 dir) and round-trip into a signer", () => {
    const p = paths();
    const k = generateAuditKey();
    writeKeyPair(k, p.key, p.pub);
    expect(statSync(p.key).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
    const loaded = loadSigner(p.key);
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) throw new Error("unreachable");
    expect(loaded.signer.keyId).toBe(k.keyId);
    const pub = loadPublicKey(p.pub);
    expect(pub).toMatchObject({ ok: true, key: { keyId: k.keyId } });
    const sig = loaded.signer.sign(Buffer.from("m"));
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a private key is never overwritten", () => {
    const p = paths();
    writeKeyPair(generateAuditKey(), p.key, p.pub);
    expect(() => writeKeyPair(generateAuditKey(), p.key, p.pub)).toThrow(/exists/);
  });

  test("a missing key is reported as missing", () => {
    expect(loadSigner(join(dir, "none.key"))).toEqual({
      ok: false,
      missing: true,
      error: `no audit signing key at ${join(dir, "none.key")}`,
    });
  });

  test("a key readable by others is refused", () => {
    const p = paths();
    writeKeyPair(generateAuditKey(), p.key, p.pub);
    chmodSync(p.key, 0o644);
    expect(loadSigner(p.key)).toMatchObject({
      ok: false,
      missing: false,
      error: expect.stringMatching(/0644/),
    });
  });

  test("garbage and non-Ed25519 keys are refused", () => {
    const bad = join(dir, "bad.key");
    writeFileSync(bad, "nope", { mode: 0o600 });
    expect(loadSigner(bad)).toMatchObject({ ok: false, missing: false });
    const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(bad, ec.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    expect(loadSigner(bad)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not an Ed25519/),
    });
    const pub = join(dir, "bad.pub");
    writeFileSync(pub, ec.publicKey.export({ format: "pem", type: "spki" }));
    expect(loadPublicKey(pub)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not an Ed25519/),
    });
    expect(loadPublicKey(join(dir, "none.pub"))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot read/),
    });
  });

  test("the pending key sits next to the key", () => {
    expect(pendingKeyPath("/k/audit-ed25519.key")).toBe("/k/audit-ed25519.key.next");
  });
});
