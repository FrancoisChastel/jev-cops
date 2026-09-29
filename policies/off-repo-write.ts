import { definePolicy, type PolicyContext, type PolicyEvent } from "@jevdict/sdk";

/**
 * off-repo-write (spec §Starter policy set): `fs.write` or `fs.delete` outside the repo
 * and outside `/tmp` → hold. Deterministic; asks nothing; never rewrites.
 *
 * Invariant: every path the call writes or deletes is checked, whatever the event-level
 * kind, so a write hidden in a `net` command (`curl -o ~/bin/tool`) still counts. Scratch
 * space is strictly *under* `/tmp` or `/private/tmp` (macOS); `/tmp` itself is not.
 */

/** Scratch directories; a path must be strictly below one of them. */
const SCRATCH_DIRS: readonly string[] = ["/tmp", "/private/tmp"];

function inScratch(path: string): boolean {
  return SCRATCH_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/** Written or deleted paths outside the repo (or cwd without one) and outside scratch. */
function offRepoTargets(e: PolicyEvent, ctx: PolicyContext): string[] {
  return Object.entries(e.fs.access)
    .filter(([, access]) => access === "write" || access === "delete")
    .map(([path]) => path)
    .filter((path) => !ctx.scope.pathInRepo(path) && !inScratch(path));
}

function first(e: PolicyEvent, ctx: PolicyContext): string {
  return offRepoTargets(e, ctx)[0] ?? "a path outside the repository";
}

export default definePolicy({
  name: "off-repo-write",
  version: 1,
  owner: "cyber-team",
  when: (e, ctx) => offRepoTargets(e, ctx).length > 0,
  decide: () => "hold",
  reason: (e, ctx) => `Writing outside the repository and /tmp: ${first(e, ctx)}.`,
  contextNote: (e, ctx) =>
    `${first(e, ctx)} is outside the repository; keep changes inside the repo or /tmp.`,
  detail: (e, ctx) => `off-repo targets: ${offRepoTargets(e, ctx).join(", ")}`,
  range: ["hold", "hold"],
});
