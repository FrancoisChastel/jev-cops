/**
 * The real SkillSpector on the two bundled fixture skills. Never in CI: it runs only with
 * `JEV_COPS_SCANNER_LIVE=1` and a `skillspector` on PATH (and static mode still sends the
 * fixtures' dependency names to OSV.dev; the fixtures declare none).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanner } from "./index.ts";
import { materialize } from "./materialize.ts";

const LIVE = process.env.JEV_COPS_SCANNER_LIVE === "1" && Bun.which("skillspector") !== null;
const SKILLS = join(import.meta.dir, "testing", "skills");
const DEADLINE_MS = 120_000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "jvscan-live-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function scanFixture(name: string) {
  const m = await materialize(join(SKILLS, name), { kind: "copy" }, root);
  if (!m.ok) throw new Error(m.error);
  try {
    const scanner = createScanner({ adapter: "skillspector" });
    return await scanner.scan({ kind: "dir", path: m.value.dir }, { deadlineMs: DEADLINE_MS });
  } finally {
    await m.value.cleanup();
  }
}

describe.skipIf(!LIVE)("live SkillSpector (JEV_COPS_SCANNER_LIVE=1)", () => {
  test(
    "is available and reports its version",
    async () => {
      const a = await createScanner({ adapter: "skillspector" }).available();
      expect(a.ok).toBe(true);
    },
    DEADLINE_MS,
  );

  test(
    "safe_skill: SAFE → safe, static, dependency names only",
    async () => {
      const r = await scanFixture("safe_skill");
      expect(r).toMatchObject({ verdict: "safe", mode: "static", network: "osv-only" });
    },
    DEADLINE_MS,
  );

  test(
    "risky_skill: DO_NOT_INSTALL → unsafe, with findings",
    async () => {
      const r = await scanFixture("risky_skill");
      expect(r.verdict).toBe("unsafe");
      expect(r.findings.length).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );
});
