import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTexts, keyIdOf, loadPublicKey, verifyAuditLines } from "@jev-cops/daemon";
import { startTestDaemon, type TestDaemon } from "../../../daemon/src/testing/daemon.ts";
import { policyModule } from "../../../daemon/src/testing/policies.ts";
import { testKey } from "../../../daemon/src/testing/signed-log.ts";
import { captureIo } from "../io.ts";
import { type KeygenDeps, runKeygenCommand } from "./keygen.ts";

let root: string;
let deps: KeygenDeps;
let td: TestDaemon | null = null;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvk-")));
  deps = { home: join(root, "home"), cwd: root, env: {} };
});

afterEach(async () => {
  await td?.stop();
  td = null;
  rmSync(root, { recursive: true, force: true });
});

const keyPath = () => join(root, "home", ".jev-cops", "keys", "audit-ed25519.key");
const pubPath = () => join(root, "home", ".config", "jev-cops", "audit-ed25519.pub");

async function keygen(...argv: string[]) {
  const io = captureIo();
  const code = await runKeygenCommand(argv, io, deps);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("cops keygen", () => {
  test("writes a private key (0600 in a 0700 dir) and the public key for the team", async () => {
    const r = await keygen();
    expect(r.code).toBe(0);
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "home", ".jev-cops", "keys")).mode & 0o777).toBe(0o700);
    const pub = loadPublicKey(pubPath());
    if (!pub.ok) throw new Error(pub.error);
    expect(r.out).toContain(`audit signing key ${pub.key.keyId}`);
    expect(r.out).toContain(pubPath());
    expect(r.out).toContain("cyber team");
    expect(keyIdOf(readFileSync(keyPath(), "utf8"))).toBe(pub.key.keyId);
  });

  test("--json names the key id and both files", async () => {
    const r = await keygen("--json");
    const body = JSON.parse(r.out) as Record<string, unknown>;
    expect(body).toMatchObject({ key: keyPath(), public_key: pubPath(), rotation: null });
    expect(body.key_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("never overwrites an existing key", async () => {
    await keygen();
    const before = readFileSync(keyPath(), "utf8");
    const r = await keygen();
    expect(r.code).toBe(1);
    expect(r.err).toContain("--rotate");
    expect(readFileSync(keyPath(), "utf8")).toBe(before);
  });

  test("key paths come from cops.toml", async () => {
    const config = join(root, "cops.toml");
    writeFileSync(config, `[audit]\nkey = "k/a.key"\npublic_key = "p/a.pub"\n`);
    expect((await keygen("--config", config)).code).toBe(0);
    expect(existsSync(join(root, "k", "a.key"))).toBe(true);
    expect(existsSync(join(root, "p", "a.pub"))).toBe(true);
  });

  test("usage errors exit 2", async () => {
    expect((await keygen("--nope")).code).toBe(2);
    expect((await keygen("extra")).code).toBe(2);
  });
});

describe("cops keygen --rotate", () => {
  test("needs a current key", async () => {
    const r = await keygen("--rotate");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no key to rotate from");
  });

  test("leaves the next key pending when copsd is not running; one rotation at a time", async () => {
    await keygen();
    const r = await keygen("--rotate", "--admin-socket", join(root, "none.sock"));
    expect(r.code).toBe(0);
    expect(statSync(`${keyPath()}.next`).mode & 0o777).toBe(0o600);
    const next = keyIdOf(readFileSync(`${keyPath()}.next`, "utf8"));
    expect(existsSync(join(root, "home", ".config", "jev-cops", `audit-ed25519.${next}.pub`))).toBe(
      true,
    );
    expect(r.out).toContain("at its next start");
    const again = await keygen("--rotate", "--admin-socket", join(root, "none.sock"));
    expect(again.code).toBe(1);
    expect(again.err).toContain("already pending");
  });

  test("a running copsd rotates at once: the log verifies from the old public key", async () => {
    const old = testKey();
    const d = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      signingKey: old.privatePem,
    });
    td = d;
    const config = join(root, "cops.toml");
    const lines = [
      "[daemon]",
      `admin_socket = ${JSON.stringify(d.config.daemon.adminSocket)}`,
      "[audit]",
      `key = ${JSON.stringify(d.config.audit.key)}`,
      `public_key = ${JSON.stringify(join(root, "team.pub"))}`,
    ];
    writeFileSync(config, `${lines.join("\n")}\n`);
    const r = await keygen("--rotate", "--config", config);
    expect(r.code).toBe(0);
    expect(r.out).toContain("rotated");
    const v = verifyAuditLines(auditTexts(d.config.audit.path), { keys: [old.pub] });
    expect(v.ok).toBe(true);
    expect(v.rotations).toHaveLength(1);
    expect(existsSync(`${d.config.audit.key}.next`)).toBe(false);
  });
});
