/**
 * T9 — TOCTOU (spec §Threat model).
 *
 * Attack: Symlink swap or env var changed between judge and run.
 * Required outcome: `rewrite` pins resolved absolute paths and expanded args via
 * `updatedInput`; unpinnable dynamic constructs are opaque exec.
 *
 * Status: live (core) for "unpinnable dynamic constructs are opaque exec"; live (Pi
 * adapter) for pinning: a `rewrite` carrying the resolved absolute path replaces the input
 * Pi runs, in place (Pi's contract; it has no `updatedInput`). Claude Code's
 * `updatedInput` mapping is M1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { register } from "../../adapters/pi/jevdict.ts";
import { FakePi, fakeContext } from "../../adapters/pi/testing/fake-pi.ts";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { bashPre } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

/** A rewrite policy that pins every resolved path of a relative `rm` (test-only). */
const PIN = `export default {
  name: "pin", version: 1, owner: "tests",
  when: (e) => e.commands.some((c) => c.argv[0] === "rm") && e.opaque.length === 0,
  decide: () => "rewrite",
  rewrite: (e) => ({ command: "rm -rf -- " + e.paths.join(" ") }),
  reason: "Pinned resolved paths.",
};
`;

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

describe("T9 TOCTOU: what cannot be pinned is opaque", () => {
  test("a $(…) path is opaque and never appears among the resolved paths", async () => {
    const n = await bashPre("rm -rf $(readlink -f build)");
    expect(n.kind).toBe("exec");
    expect(n.opaque.map((o) => o.reason)).toContain("command-substitution");
    expect(n.paths.some((p) => p.includes("$("))).toBe(false);
    const deletes = n.commands.flatMap((c) => c.pathRefs).filter((r) => r.access === "delete");
    expect(deletes).toEqual([]);
  });

  test("an env var other than HOME is dynamic, opaque, and not a resolved path", async () => {
    const n = await bashPre("rm -rf $TARGET_DIR/cache");
    expect(n.kind).toBe("exec");
    expect(n.opaque.map((o) => o.reason)).toContain("dynamic-expansion");
    expect(n.paths).toEqual([]);
  });

  test("literal paths are resolved to absolute form, ready to pin", async () => {
    const n = await bashPre("rm -rf ./build/../dist ~/tmp");
    expect(n.opaque).toEqual([]);
    expect(n.paths).toEqual(["/work/repo/dist", "/home/dev/tmp"]);
  });

  test("Pi: rewrite pins resolved absolute paths and expanded args in the input Pi runs", async () => {
    td = await startTestDaemon({ policies: { "pin.ts": PIN } });
    const pi = new FakePi();
    register(pi, { socket: td.config.daemon.socket });
    const ctx = fakeContext({ cwd: td.dir });
    const run = await pi.run(ctx, "bash", { command: "rm -rf ./build/../dist ~/tmp" });
    expect(run.blocked).toBeUndefined();
    expect(run.input).toEqual({ command: `rm -rf -- ${td.dir}/dist /home/dev/tmp` });
  });

  test.todo(
    "Claude Code: rewrite pins resolved absolute paths and expanded args via updatedInput",
    pending("M1 (Claude Code hooks)"),
  );
});
