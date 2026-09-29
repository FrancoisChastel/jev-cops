/**
 * T12 — Log tampering (spec §Threat model).
 *
 * Attack: Agent edits or truncates the audit log
 * Required outcome: Log is append-only, hash-chained, and shipped off-box; a chain break is an alert
 *
 * Status: live for the hash chain: a real daemon's log verifies, and an edit, a deleted
 * line or a cut line breaks the chain at that seq. Shipping off-box (the syslog/S3
 * forwarder) and `jevdict doctor` verifying the chain are M2.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { verifyChain } from "../../packages/daemon/src/audit.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../packages/daemon/src/testing/daemon.ts";
import { policyModule } from "../../packages/daemon/src/testing/policies.ts";
import { buildEvent } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

let td: TestDaemon;
let path: string;

beforeEach(async () => {
  td = await startTestDaemon({ policies: { "ok.ts": policyModule("ok") } });
  for (const command of ["ls", "cat README.md", "rm -rf build"]) {
    await td.call(
      "POST",
      "/v1/judge",
      withFreshId(buildEvent({ tool: "Bash", kind: "exec", input: { command } })),
    );
  }
  path = td.config.audit.path;
});

afterEach(async () => {
  await td.stop();
});

function lines(): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "");
}

describe("T12 log tampering", () => {
  test("the daemon's log is a valid chain", () => {
    expect(verifyChain(path)).toEqual({ ok: true, lines: 4 });
  });

  test("hash chain detects an edited line", () => {
    const l = lines();
    l[2] = (l[2] ?? "").replace('"verdict":"allow"', '"verdict":"deny"');
    writeFileSync(path, `${l.join("\n")}\n`);
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test("hash chain detects a deleted line", () => {
    const l = lines();
    writeFileSync(path, `${[l[0], l[1], l[3]].join("\n")}\n`);
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 4 });
  });

  test("hash chain detects truncation inside a line", () => {
    const l = lines();
    writeFileSync(path, `${[l[0], l[1], (l[2] ?? "").slice(0, 40)].join("\n")}\n`);
    expect(verifyChain(path)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  test.todo(
    "the log is shipped off-box and jevdict doctor alerts on a chain break (catches tail truncation)",
    pending("M2 (forwarder, jevdict doctor)"),
  );
});
