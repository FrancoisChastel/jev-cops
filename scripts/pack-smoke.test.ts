import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The install half of the pack smoke test needs the npm registry (third-party
 * dependencies), so plain `bun test` skips it; CI runs `bun run pack:smoke` as its own step.
 * `JEV_COPS_PACK_SMOKE=1 bun test scripts` runs it here too.
 */
const enabled = process.env.JEV_COPS_PACK_SMOKE === "1";

describe("pack smoke", () => {
  test.skipIf(!enabled)(
    "every tarball installs globally and cops, copsd and cops-hook work from it",
    async () => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "pack-smoke.ts")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(out).toContain("pack-smoke: PASS");
      expect(code).toBe(0);
    },
    300_000,
  );
});
