import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureIo } from "../io.ts";
import { runTestCommand } from "./test.ts";

const REPO_POLICIES = join(import.meta.dir, "..", "..", "..", "..", "policies");
const PRE_BASH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "events",
  "pre-bash.json",
);

function plainPolicy(verdict: string): string {
  return `export default {
  name: "plain", version: 1, owner: "tests",
  when: () => true, decide: () => ${JSON.stringify(verdict)}, reason: "plain",
};
`;
}

function fixtures(expected: string): string {
  const event = JSON.parse(readFileSync(PRE_BASH, "utf8")) as unknown;
  return JSON.stringify({
    policy: "plain",
    cases: [{ name: "one", event, expect: { verdict: expected } }],
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-cli-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cops test", () => {
  test("the repo's policies are green (the M0 gate)", async () => {
    const io = captureIo();
    expect(await runTestCommand([REPO_POLICIES], io)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("default-branch-guard");
    expect(text).toContain("with set");
    expect(text).toMatch(/PASS$/m);
  });

  test("a failing fixture exits 1 and shows the diff", async () => {
    writeFileSync(join(dir, "plain.ts"), plainPolicy("hold"));
    writeFileSync(join(dir, "plain.fixtures.json"), fixtures("allow"));
    const io = captureIo();
    expect(await runTestCommand([dir], io)).toBe(1);
    const text = io.stdout.join("\n");
    expect(text).toContain("FAIL plain (alone) · one");
    expect(text).toContain("verdict: expected allow, got hold");
    expect(text).toMatch(/FAIL$/m);
  });

  test("a passing temp directory exits 0", async () => {
    writeFileSync(join(dir, "plain.ts"), plainPolicy("hold"));
    writeFileSync(join(dir, "plain.fixtures.json"), fixtures("hold"));
    expect(await runTestCommand([dir], captureIo())).toBe(0);
  });

  test("a loader problem or a policy without fixtures exits 1", async () => {
    writeFileSync(join(dir, "plain.ts"), plainPolicy("hold"));
    const io = captureIo();
    expect(await runTestCommand([dir], io)).toBe(1);
    expect(io.stdout.join("\n")).toContain("plain has no fixtures");
    writeFileSync(join(dir, "plain.fixtures.json"), fixtures("hold"));
    writeFileSync(join(dir, "broken.ts"), "export default { name: 3 };\n");
    expect(await runTestCommand([dir], captureIo())).toBe(1);
  });

  test("fixtures for an unknown policy exit 1", async () => {
    writeFileSync(join(dir, "plain.ts"), plainPolicy("hold"));
    writeFileSync(join(dir, "plain.fixtures.json"), fixtures("hold"));
    writeFileSync(join(dir, "ghost.fixtures.json"), fixtures("hold").replace('"plain"', '"ghost"'));
    const io = captureIo();
    expect(await runTestCommand([dir], io)).toBe(1);
    expect(io.stdout.join("\n")).toContain("ghost");
  });

  test("--json prints a machine-readable report", async () => {
    writeFileSync(join(dir, "plain.ts"), plainPolicy("hold"));
    writeFileSync(join(dir, "plain.fixtures.json"), fixtures("hold"));
    const io = captureIo();
    expect(await runTestCommand([dir, "--json"], io)).toBe(0);
    const report = JSON.parse(io.stdout.join("\n")) as { ok: boolean; rows: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.rows).toHaveLength(1);
  });

  test("usage errors exit 2", async () => {
    expect(await runTestCommand(["a", "b"], captureIo())).toBe(2);
  });
});
