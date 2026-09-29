/**
 * T9 — TOCTOU (spec §Threat model).
 *
 * Attack: Symlink swap or env var changed between judge and run.
 * Required outcome: `rewrite` pins resolved absolute paths and expanded args via
 * `updatedInput`; unpinnable dynamic constructs are opaque exec.
 *
 * Status: live (core) for "unpinnable dynamic constructs are opaque exec". Pinning via
 * `rewrite` lands with the policy engine and the Pi adapter (M0 steps 5 and 10).
 */
import { describe, expect, test } from "bun:test";
import { bashPre } from "../fixtures/context/index.ts";
import { pending } from "./pending.ts";

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

  test.todo(
    "rewrite pins resolved absolute paths and expanded args via updatedInput (M0 step 5)",
    pending("M0 step 5"),
  );
});
