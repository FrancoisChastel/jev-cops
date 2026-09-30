/**
 * The real SkillSpector on the two bundled fixture skills, only ever inside a container
 * (owner rule: no live run against this host's own tools). Never in CI. Two ways in:
 *
 * - `JEV_COPS_SCANNER_LIVE_IMAGE=<image>` with `docker` on PATH: the `skillspector` adapter's
 *   docker form runs the tool in that image (built from NVIDIA/SkillSpector's Dockerfile);
 * - `JEV_COPS_SCANNER_LIVE=1` when this test itself runs inside a container (`/.dockerenv`
 *   or `/run/.containerenv`) with `skillspector` on PATH.
 *
 * Static mode still sends the fixtures' dependency names to OSV.dev; the fixtures declare none.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanner, type ScannerConfig } from "./index.ts";
import { materialize } from "./materialize.ts";

const IMAGE = process.env.JEV_COPS_SCANNER_LIVE_IMAGE ?? "";
const IN_CONTAINER = existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/** The live config, or null when no container is available to run the tool in. */
function liveConfig(): ScannerConfig | null {
  if (IMAGE !== "" && Bun.which("docker") !== null) {
    return { adapter: "skillspector", docker: { image: IMAGE } };
  }
  const inContainer = process.env.JEV_COPS_SCANNER_LIVE === "1" && IN_CONTAINER;
  return inContainer && Bun.which("skillspector") !== null ? { adapter: "skillspector" } : null;
}

const CONFIG = liveConfig();
const SKILLS = join(import.meta.dir, "testing", "skills");
const DEADLINE_MS = 180_000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "jvscan-live-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function scanFixture(config: ScannerConfig, name: string) {
  const m = await materialize(join(SKILLS, name), { kind: "copy" }, root);
  if (!m.ok) throw new Error(m.error);
  try {
    return await createScanner(config).scan(
      { kind: "dir", path: m.value.dir },
      { deadlineMs: DEADLINE_MS },
    );
  } finally {
    await m.value.cleanup();
  }
}

describe.skipIf(CONFIG === null)("live SkillSpector, in a container", () => {
  const config = CONFIG ?? { adapter: "none" };

  test(
    "is available and reports its version",
    async () => {
      expect((await createScanner(config).available()).ok).toBe(true);
    },
    DEADLINE_MS,
  );

  test(
    "safe_skill: SAFE → safe, static, dependency names only",
    async () => {
      const r = await scanFixture(config, "safe_skill");
      expect(r).toMatchObject({ verdict: "safe", mode: "static", network: "osv-only" });
    },
    DEADLINE_MS,
  );

  test(
    "risky_skill: DO_NOT_INSTALL → unsafe, with findings",
    async () => {
      const r = await scanFixture(config, "risky_skill");
      expect(r.verdict).toBe("unsafe");
      expect(r.findings.length).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );
});
