import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvent } from "../../../../tests/fixtures/context/index.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../../daemon/src/testing/daemon.ts";
import { policyModule } from "../../../daemon/src/testing/policies.ts";
import { testKey } from "../../../daemon/src/testing/signed-log.ts";
import { REPO_POLICIES } from "../testing/doctor.ts";
import { auditChecks } from "./doctor-audit.ts";
import { daemonChecks, fetchHealth, probeDaemon } from "./doctor-daemon.ts";
import type { Check } from "./doctor-types.ts";

const byName = (checks: readonly Check[], name: string): Check | undefined =>
  checks.find((c) => c.name === name);

let enforce: TestDaemon;
let observe: TestDaemon;
let scratch = "";

beforeAll(async () => {
  enforce = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
  observe = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") }, mode: "observe" });
  scratch = mkdtempSync(join(tmpdir(), "jvdoc-"));
});

afterAll(async () => {
  await enforce.stop();
  await observe.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe("doctor: copsd health on both sockets", () => {
  test("a healthy enforcing daemon: both sockets answer, policies, enforcement, protected paths", async () => {
    const { socket, adminSocket } = enforce.config.daemon;
    const probe = await probeDaemon(socket, adminSocket);
    const checks = daemonChecks(probe);
    expect(byName(checks, "agent socket")).toMatchObject({ status: "ok" });
    expect(byName(checks, "agent socket")?.detail).toContain(socket);
    expect(byName(checks, "admin socket")).toMatchObject({ status: "ok" });
    expect(byName(checks, "version")).toMatchObject({ status: "ok" });
    const policies = byName(checks, "policies");
    expect(policies?.status).toBe("ok");
    expect(policies?.detail).toContain("config-tamper@");
    expect(byName(checks, "enforcement")).toMatchObject({ status: "ok", detail: "enforce" });
    expect(byName(checks, "judge")).toMatchObject({ status: "warn" });
    expect(byName(checks, "judge")?.detail).toContain("disabled");
    expect(byName(checks, "protected paths")?.status).toBe("ok");
    expect(checks.every((c) => c.group === "copsd")).toBe(true);
  });

  test("observe mode warns that no verdict is enforced; a set without config-tamper fails (T1 off)", async () => {
    const probe = await probeDaemon(
      observe.config.daemon.socket,
      observe.config.daemon.adminSocket,
    );
    const checks = daemonChecks(probe);
    expect(byName(checks, "enforcement")?.status).toBe("warn");
    expect(byName(checks, "enforcement")?.detail).toContain("no verdict is enforced");
    expect(byName(checks, "policies")?.status).toBe("fail");
    expect(byName(checks, "policies")?.detail).toContain("config-tamper is not loaded");
  });

  test("daemon down: the agent socket fails with a hint, the rest is not guessed", async () => {
    const probe = await probeDaemon(join(scratch, "none.sock"), join(scratch, "none-admin.sock"));
    const checks = daemonChecks(probe);
    const agent = byName(checks, "agent socket");
    expect(agent?.status).toBe("fail");
    expect(agent?.detail).toContain("start copsd");
    expect(agent?.detail).toContain("fail closed");
    expect(byName(checks, "admin socket")?.status).toBe("warn");
    expect(byName(checks, "enforcement")).toBeUndefined();
  });

  test("only the admin socket answers: the agent socket fails, facts come from the admin socket", async () => {
    const probe = await probeDaemon(join(scratch, "none.sock"), enforce.config.daemon.adminSocket);
    const checks = daemonChecks(probe);
    expect(byName(checks, "agent socket")?.status).toBe("fail");
    expect(byName(checks, "admin socket")?.status).toBe("ok");
    expect(byName(checks, "enforcement")?.detail).toBe("enforce");
  });

  test("the agent socket named as admin: warned (D-060: they must differ)", async () => {
    const socket = enforce.config.daemon.socket;
    const checks = daemonChecks(await probeDaemon(socket, socket));
    const admin = byName(checks, "admin socket");
    expect(admin?.status).toBe("warn");
    expect(admin?.detail).toContain("must differ");
  });

  test("an admin socket other than the daemon's: warned", async () => {
    const probe = await probeDaemon(
      enforce.config.daemon.socket,
      observe.config.daemon.adminSocket,
    );
    const admin = byName(daemonChecks(probe), "admin socket");
    expect(admin?.status).toBe("warn");
    expect(admin?.detail).toContain(enforce.config.daemon.adminSocket);
  });

  test("a reply that is not health: unreachable with the reason", async () => {
    const socket = join(scratch, "odd.sock");
    const server = Bun.serve({ unix: socket, fetch: () => Response.json({ hello: 1 }) });
    try {
      const reply = await fetchHealth(socket);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error).toContain("not a copsd health reply");
    } finally {
      await server.stop(true);
    }
  });

  test("zero policies fail, degraded and version drift warn", () => {
    const health = {
      version: "9.9.9",
      policies: [{ name: "config-tamper", version: 2, degraded: true }],
      judge: "mock",
      enforcement: "enforce" as const,
      sockets: { agent: "/a.sock", admin: "/b.sock" },
      protected_paths: 0,
      latched_sessions: 3,
    };
    const up = { ok: true as const, health };
    const checks = daemonChecks({
      socket: "/a.sock",
      adminSocket: "/b.sock",
      agent: up,
      admin: up,
    });
    expect(byName(checks, "version")?.status).toBe("warn");
    expect(byName(checks, "policies")?.status).toBe("warn");
    expect(byName(checks, "policies")?.detail).toContain("degraded: config-tamper@2");
    expect(byName(checks, "judge")).toMatchObject({ status: "ok", detail: "mock" });
    expect(byName(checks, "protected paths")?.status).toBe("warn");
    expect(byName(checks, "latched sessions")?.detail).toContain("3");
    const none = { ...up, health: { ...health, policies: [] } };
    const empty = daemonChecks({
      socket: "/a.sock",
      adminSocket: "/b.sock",
      agent: none,
      admin: none,
    });
    expect(byName(empty, "policies")?.status).toBe("fail");
  });
});

describe("doctor: audit checks on a real copsd's signed log (T12)", () => {
  let td: TestDaemon;
  const key = testKey();
  beforeAll(async () => {
    td = await startTestDaemon({
      policies: { "ok.ts": policyModule("ok") },
      signingKey: key.privatePem,
    });
    for (const command of ["ls", "cat README.md"]) {
      const e = withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command } }));
      await td.call("POST", "/v1/judge", e);
    }
  });
  afterAll(async () => {
    await td.stop();
  });

  async function checks(path: string) {
    const pub = join(scratch, "team.pub");
    writeFileSync(pub, key.publicPem);
    const reply = await fetchHealth(td.config.daemon.socket);
    const health = reply.ok ? (reply.health.audit ?? null) : null;
    const input = { path, keyPath: td.config.audit.key, publicKey: pub, requireSigning: false };
    return auditChecks({ ...input, remote: null, health });
  }

  test("an intact log verifies: chain, signatures, the key copsd runs with", async () => {
    const c = await checks(td.config.audit.path);
    expect(byName(c, "chain")).toMatchObject({ group: "audit", status: "ok" });
    expect(byName(c, "signatures")?.status).toBe("ok");
    expect(byName(c, "signing key")?.detail).toContain(key.pub.keyId);
    expect(byName(c, "forwarding")?.status).toBe("warn");
  });

  test("a tampered log is a failure naming the broken seq", async () => {
    const copy = join(scratch, "tampered.jsonl");
    const lines = readFileSync(td.config.audit.path, "utf8").split("\n");
    lines[2] = (lines[2] ?? "").replace('"verdict":"allow"', '"verdict":"deny"');
    writeFileSync(copy, lines.join("\n"));
    const c = await checks(copy);
    expect(byName(c, "chain")?.status).toBe("fail");
    expect(byName(c, "chain")?.detail).toContain("broken at seq 3");
  });
});
