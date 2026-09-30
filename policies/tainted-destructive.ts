import { definePolicy, type PolicyContext, type PolicyEvent } from "@jev-cops/sdk";

/**
 * tainted-destructive (spec §Starter policy set): an `fs.delete` or an irreversible exec
 * whose target came from tool output → hold to deny. Deterministic; asks nothing.
 *
 * Invariant: user-typed text is never tainted (the context engine scores words from the
 * task at 0), so a destructive command the user asked for never matches; anything the
 * agent could only have learned from a tool result does.
 */

/** Verbs the normalizer attaches to irreversible commands (`rm -f`, `push --force`, `reset --hard`). */
const IRREVERSIBLE_VERBS: readonly string[] = ["force", "hard", "irreversible"];
/** At or above this taint (event fraction, or any one target) the action is denied. */
const DENY_TAINT = 0.5;

function destructive(e: PolicyEvent): boolean {
  return e.kind === "fs.delete" || e.verbs.some((v) => IRREVERSIBLE_VERBS.includes(v));
}

/** Paths the command deletes or writes; every path when none is classified as a target. */
function targets(e: PolicyEvent): string[] {
  const written = Object.entries(e.fs.access)
    .filter(([, access]) => access === "delete" || access === "write")
    .map(([path]) => path);
  return written.length > 0 ? written : [...e.paths];
}

function taintedTargets(e: PolicyEvent, ctx: PolicyContext): string[] {
  return targets(e).filter((p) => ctx.taint.of(p) >= DENY_TAINT);
}

export default definePolicy({
  name: "tainted-destructive",
  version: 1,
  owner: "cyber-team",
  when: (e, ctx) => destructive(e) && ctx.taint.fraction > 0,
  decide: (e, ctx) =>
    ctx.taint.fraction >= DENY_TAINT || taintedTargets(e, ctx).length > 0 ? "deny" : "hold",
  reason: "Destructive action on a target that came from tool output, not from the user.",
  detail: (e, ctx) => {
    const tainted = taintedTargets(e, ctx);
    const list = tainted.length > 0 ? tainted.join(", ") : "none above the deny threshold";
    return `tainted targets: ${list}`;
  },
  range: ["hold", "deny"],
});
