import { definePolicy, type PolicyContext, type PolicyEvent } from "@jev-cops/sdk";

/**
 * default-branch-guard (spec §Starter policy set): irreversible git on the default
 * branch → hold, deny when headless. Deterministic; asks nothing.
 *
 * Invariant: the default branches are `ctx.env.defaultBranches`: `main` and `master`
 * always, plus the reported `env.git.default_branch` (D-068), so repointing `origin/HEAD`
 * cannot make `main` stop counting. An unknown current branch is not the default, as in
 * the environment feature. A force push whose refspec names a default branch counts too,
 * whatever branch is checked out, since that is the branch it overwrites.
 */

const IRREVERSIBLE_VERBS: readonly string[] = ["force", "hard", "irreversible"];

type Command = PolicyEvent["commands"][number];

/** The destination branch a push word names: `main`, `+main`, `HEAD:main`, `refs/heads/main`. */
function pushDestination(word: string): string {
  const dest = word.replace(/^\+/, "").split(":").at(-1) ?? "";
  return dest.replace(/^refs\/heads\//, "");
}

function pushesTo(c: Command, branches: readonly string[]): boolean {
  if (!c.verbs.includes("push")) return false;
  const words = c.argv.slice(c.argv.indexOf("push") + 1).filter((w) => !w.startsWith("-"));
  return words.some((w) => branches.includes(pushDestination(w)));
}

function irreversibleGit(c: Command): boolean {
  return c.verbs.includes("git") && c.verbs.some((v) => IRREVERSIBLE_VERBS.includes(v));
}

function hitsDefaultBranch(e: PolicyEvent, ctx: PolicyContext): boolean {
  const { defaultBranches, onDefaultBranch } = ctx.env;
  return e.commands.some(
    (c) => irreversibleGit(c) && (onDefaultBranch || pushesTo(c, defaultBranches)),
  );
}

export default definePolicy({
  name: "default-branch-guard",
  version: 2,
  owner: "cyber-team",
  when: (e, ctx) => hitsDefaultBranch(e, ctx),
  decide: (e) => (e.session.mode === "headless" ? "deny" : "hold"),
  reason: "Irreversible git operation on the default branch.",
  detail: (e, ctx) =>
    `branch ${e.env.git?.branch ?? "unknown"}; default ${ctx.env.defaultBranches.join("/")}; mode ${e.session.mode ?? "unknown"}`,
  range: ["hold", "deny"],
});
