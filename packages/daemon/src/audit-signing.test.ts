import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildEvent } from "../../../tests/fixtures/context/index.ts";
import { auditTexts } from "./audit.ts";
import { parseCheckpoint } from "./audit-sign/checkpoint.ts";
import { keyIdOf } from "./audit-sign/keys.ts";
import { verifyAuditLines } from "./audit-verify.ts";
import { startTestDaemon, type TestDaemon, withFreshId } from "./testing/daemon.ts";
import { policyModule } from "./testing/policies.ts";
import { sessionReport, TEST_SESSION } from "./testing/session.ts";
import { testKey } from "./testing/signed-log.ts";

let td: TestDaemon | null = null;

afterEach(async () => {
  await td?.stop();
  td = null;
});

const key = testKey();
const POLICIES = { "ok.ts": policyModule("ok") };

function reasons(d: TestDaemon): string[] {
  return d
    .audit()
    .filter((l) => l.kind === "checkpoint")
    .map((l) => {
      const c = parseCheckpoint(l.payload);
      return c.ok ? c.value.reason : "malformed";
    });
}

describe("copsd signs its audit log (D-104)", () => {
  test("a checkpoint follows the boot line, a root session's end and the shutdown line", async () => {
    const d = await startTestDaemon({ policies: POLICIES, signingKey: key.privatePem });
    td = d;
    expect(reasons(d)).toEqual(["boot"]);
    const end = await d.call("POST", "/v1/session", sessionReport("end"));
    expect(end.status).toBe(200);
    expect(reasons(d)).toEqual(["boot", "session-end"]);
    const child = { sessionId: "sess_child", parentId: TEST_SESSION };
    await d.call("POST", "/v1/session", sessionReport("start", {}, child));
    await d.call("POST", "/v1/session", sessionReport("end", {}, child));
    expect(reasons(d)).toEqual(["boot", "session-end"]);
    const path = d.config.audit.path;
    await d.stop({ keepFiles: true });
    const texts = auditTexts(path);
    const v = verifyAuditLines(texts, { keys: [key.pub] });
    expect(v).toMatchObject({ ok: true, unsignedTail: null });
    expect(texts.at(-2)).toContain('"event":"shutdown"');
    td = await startTestDaemon({ policies: POLICIES, dir: d.dir, signingKey: key.privatePem });
    expect(reasons(td).slice(0, 4)).toEqual(["boot", "session-end", "shutdown", "boot"]);
  });

  test("every checkpoint_every lines while judging", async () => {
    const d = await startTestDaemon({
      policies: POLICIES,
      signingKey: key.privatePem,
      checkpointEvery: 2,
    });
    td = d;
    for (let i = 0; i < 4; i++) {
      await d.call(
        "POST",
        "/v1/judge",
        withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command: "ls" } })),
      );
    }
    expect(reasons(d).filter((r) => r === "interval").length).toBeGreaterThanOrEqual(2);
    expect(verifyAuditLines(auditTexts(d.config.audit.path), { keys: [key.pub] }).ok).toBe(true);
  });

  test("health reports the key, the key in force and the last checkpoint", async () => {
    const d = await startTestDaemon({ policies: POLICIES, signingKey: key.privatePem });
    td = d;
    const body = (await d.call("GET", "/v1/health")).body as { audit: { signing: unknown } };
    expect(body.audit.signing).toEqual({
      key_id: key.pub.keyId,
      in_force: key.pub.keyId,
      checkpoint_every: 100,
      last_checkpoint_seq: 2,
      required: false,
    });
  });
});

describe("without a key", () => {
  test("copsd runs unsigned with a loud warning", async () => {
    const d = await startTestDaemon({ policies: POLICIES });
    td = d;
    expect(reasons(d)).toEqual([]);
    expect(d.daemon.runtime.warnings.join(" ")).toContain("audit checkpoints unsigned");
    expect(d.daemon.runtime.warnings.join(" ")).toContain("cops keygen");
  });

  test("require_signing = true refuses to start", async () => {
    await expect(startTestDaemon({ policies: POLICIES, requireSigning: true })).rejects.toThrow(
      /require_signing = true and no audit signing key/,
    );
  });
});

describe("key rotation", () => {
  test("a pending key is announced by the old key at boot and signs from then on", async () => {
    const next = testKey();
    const d = await startTestDaemon({
      policies: POLICIES,
      signingKey: key.privatePem,
      pendingKey: next.privatePem,
    });
    td = d;
    const keyPath = d.config.audit.key;
    expect(existsSync(`${keyPath}.next`)).toBe(false);
    expect(keyIdOf(readFileSync(keyPath, "utf8"))).toBe(next.pub.keyId);
    const v = verifyAuditLines(auditTexts(d.config.audit.path), { keys: [key.pub] });
    expect(v.ok).toBe(true);
    expect(v.rotations).toEqual([
      expect.objectContaining({ from: key.pub.keyId, to: next.pub.keyId }),
    ]);
    expect(d.daemon.runtime.audit.signing().keyId).toBe(next.pub.keyId);
  });

  test("the admin socket rotates a running copsd; the agent socket cannot", async () => {
    const next = testKey();
    const d = await startTestDaemon({ policies: POLICIES, signingKey: key.privatePem });
    td = d;
    expect((await d.callAdmin("POST", "/v1/audit/rotate", {})).status).toBe(404);
    writeFileSync(`${d.config.audit.key}.next`, next.privatePem, { mode: 0o600 });
    expect((await d.call("POST", "/v1/audit/rotate", {})).status).toBe(404);
    const reply = await d.callAdmin("POST", "/v1/audit/rotate", {});
    expect(reply).toMatchObject({ status: 200, body: { ok: true, key_id: next.pub.keyId } });
    expect(reasons(d)).toEqual(["boot", "rotation"]);
    expect(verifyAuditLines(auditTexts(d.config.audit.path), { keys: [key.pub] }).ok).toBe(true);
  });

  test("the rotate route refuses an unusable pending key (400) and an unsigned copsd (409)", async () => {
    const d = await startTestDaemon({ policies: POLICIES, signingKey: key.privatePem });
    td = d;
    writeFileSync(`${d.config.audit.key}.next`, "garbage", { mode: 0o600 });
    expect((await d.callAdmin("POST", "/v1/audit/rotate", {})).status).toBe(400);
    await d.stop();
    const unsigned = await startTestDaemon({ policies: POLICIES });
    td = unsigned;
    writeFileSync(`${unsigned.config.audit.key}.next`, testKey().privatePem, { mode: 0o600 });
    const reply = await unsigned.callAdmin("POST", "/v1/audit/rotate", {});
    expect(reply).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining("restart") },
    });
  });

  test("a crash between the rotation line and the key swap does not rotate twice", async () => {
    const next = testKey();
    const d = await startTestDaemon({ policies: POLICIES, signingKey: key.privatePem });
    d.daemon.runtime.audit.rotate(next.signer);
    await d.stop({ keepFiles: true });
    writeFileSync(`${d.config.audit.key}.next`, next.privatePem, { mode: 0o600 });
    td = await startTestDaemon({ policies: POLICIES, dir: d.dir, signingKey: key.privatePem });
    expect(reasons(td).filter((r) => r === "rotation")).toHaveLength(1);
    expect(td.daemon.runtime.audit.signing().keyId).toBe(next.pub.keyId);
    expect(verifyAuditLines(auditTexts(td.config.audit.path), { keys: [key.pub] }).ok).toBe(true);
  });

  test("a key swapped without a rotation is an anomaly and a warning", async () => {
    const d = await startTestDaemon({ policies: POLICIES, signingKey: key.privatePem });
    await d.stop({ keepFiles: true });
    writeFileSync(d.config.audit.key, testKey().privatePem);
    td = await startTestDaemon({ policies: POLICIES, dir: d.dir });
    expect(td.daemon.runtime.warnings.join(" ")).toContain("is not the key in force");
    expect(td.audit().some((l) => String(l.payload.reason).includes("not the key in force"))).toBe(
      true,
    );
  });
});
