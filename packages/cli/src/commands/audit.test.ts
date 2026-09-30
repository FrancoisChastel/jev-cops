import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLine } from "@jev-cops/daemon";
import { octetFrame, syslogMessages } from "../../../daemon/src/audit-forward/syslog-format.ts";
import {
  recompute,
  signedLog,
  type TestKey,
  testKey,
} from "../../../daemon/src/testing/signed-log.ts";
import { captureIo } from "../io.ts";
import { runAuditCommand } from "./audit.ts";

let dir: string;
const key = testKey();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jva-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, texts: readonly string[]): string {
  const path = join(dir, name);
  writeFileSync(path, texts.length === 0 ? "" : `${texts.join("\n")}\n`);
  return path;
}

function pub(k: TestKey = key, name = "team.pub"): string {
  const path = join(dir, name);
  writeFileSync(path, k.publicPem);
  return path;
}

async function audit(...argv: string[]) {
  const io = captureIo();
  const code = await runAuditCommand(argv, io);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("cops audit verify", () => {
  test("an intact signed log verifies (exit 0) and says what is signed", async () => {
    const r = await audit("verify", file("a.jsonl", signedLog(key, 7, 3)), "--pubkey", pub());
    expect(r.code).toBe(0);
    expect(r.out).toContain("chain          ok");
    expect(r.out).toContain("2 verified, signed through seq 7");
    expect(r.out).toContain("unsigned tail  seq 9..9 (1 line)");
    expect(r.out).toContain("result: verified");
  });

  test("--json is one document with the schema tag", async () => {
    const r = await audit(
      "verify",
      file("a.jsonl", signedLog(key, 4, 3)),
      "--pubkey",
      pub(),
      "--json",
    );
    const body = JSON.parse(r.out) as Record<string, unknown>;
    expect(body).toMatchObject({
      schema: "jev-cops.audit-verify/1",
      ok: true,
      local: { lines: 5, head_seq: 5, checkpoints: 1, signed_through: 3 },
      remote: null,
      failures: [],
    });
  });

  test("a full recompute without the key fails (exit 1)", async () => {
    const texts = recompute(signedLog(key, 7, 3), 2, { i: 7 });
    const r = await audit("verify", file("a.jsonl", texts), "--pubkey", pub());
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL");
    expect(r.out).toContain("checkpoint seq 4");
    expect(r.out).toContain("result: FAILED");
  });

  test("a wrong public key fails; several --pubkey are all trusted", async () => {
    const other = testKey();
    const log = file("a.jsonl", signedLog(key, 4, 3));
    expect((await audit("verify", log, "--pubkey", pub(other, "o.pub"))).code).toBe(1);
    const both = await audit("verify", log, "--pubkey", pub(other, "o.pub"), "--pubkey", pub());
    expect(both.code).toBe(0);
  });

  test("a broken chain names the seq", async () => {
    const texts = signedLog(key, 4, 3);
    texts[1] = (texts[1] ?? "").replace('"i":1', '"i":5');
    const r = await audit("verify", file("a.jsonl", texts), "--pubkey", pub());
    expect(r.code).toBe(1);
    expect(r.out).toContain("broken at seq 2");
  });
});

describe("cops audit verify --remote", () => {
  test("a longer off-box copy: the local tail was truncated (exit 1)", async () => {
    const texts = signedLog(key, 7, 3);
    const r = await audit(
      "verify",
      file("local.jsonl", texts.slice(0, 4)),
      "--pubkey",
      pub(),
      "--remote",
      file("remote.jsonl", texts),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("local tail truncated after seq 4");
  });

  test("a raw syslog capture that agrees verifies; a shorter one is lag (warn, exit 0)", async () => {
    const texts = signedLog(key, 5, 3);
    const format = {
      facility: 16,
      hostname: "h",
      appName: "copsd",
      procId: "1",
      enterpriseNumber: 32473,
      maxMessageBytes: 2048,
    };
    const frames = texts
      .slice(0, 4)
      .map((t) => parseLine(t))
      .flatMap((l) => (l === null ? [] : syslogMessages(l, format).map(octetFrame)));
    const capture = join(dir, "capture.raw");
    writeFileSync(capture, Buffer.concat(frames));
    const r = await audit("verify", file("a.jsonl", texts), "--pubkey", pub(), "--remote", capture);
    expect(r.code).toBe(0);
    expect(r.out).toContain("syslog-frames");
    expect(r.out).toContain("forwarding lag: 2");
    const json = await audit(
      "verify",
      file("b.jsonl", texts),
      "--pubkey",
      pub(),
      "--remote",
      capture,
      "--json",
    );
    expect(JSON.parse(json.out)).toMatchObject({
      remote: { format: "syslog-frames", head_seq: 4, lag: 2 },
    });
  });

  test("content that differs from the copy fails", async () => {
    const texts = signedLog(key, 4, 3);
    const r = await audit(
      "verify",
      file("a.jsonl", texts),
      "--pubkey",
      pub(),
      "--remote",
      file("r.jsonl", recompute(texts, 2, { i: 9 })),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("differ at seq 2");
  });
});

describe("usage and unreadable input", () => {
  test("exit 2 for usage, 1 for a file that cannot be read", async () => {
    expect((await audit()).code).toBe(2);
    expect((await audit("nope")).code).toBe(2);
    expect((await audit("verify", "--pubkey", pub())).code).toBe(2);
    expect((await audit("verify", file("a.jsonl", []))).code).toBe(2);
    expect((await audit("verify", join(dir, "none.jsonl"), "--pubkey", pub())).code).toBe(1);
    const log = file("a.jsonl", signedLog(key, 1, 3));
    expect((await audit("verify", log, "--pubkey", join(dir, "none.pub"))).code).toBe(1);
    expect((await audit("verify", log, "--pubkey", pub(), "--remote", join(dir, "x"))).code).toBe(
      1,
    );
  });
});
