import { definePolicy, type PolicyEvent } from "@jevdict/sdk";

/**
 * default-branch-guard (spec §Starter policy set): irreversible git on the default
 * branch → hold, deny when headless. Deterministic; asks nothing.
 *
 * Invariant: the default branch is `env.git.default_branch`, or `main`/`master` when the
 * adapter did not report one (D-024); an unknown current branch is not the default, as
 * in the environment feature. A force push whose refspec names the default branch counts
 * too, whatever branch is checked out, since that is the branch it overwrites.
 */

/** D-024 fallback, mirrored from the context engine's `fallbackDefaultBranches`. */
const FALLBACK_DEFAULT_BRANCHES: readonly string[] = ["main", "master"];
const IRREVERSIBLE_VERBS: readonly string[] = ["force", "hard", "irreversible"];

type Command = PolicyEvent["commands"][number];

function defaultBranches(e: PolicyEvent): readonly string[] {
  const reported = e.env.git?.default_branch;
  return reported === undefined ? FALLBACK_DEFAULT_BRANCHES : [reported];
}

function onDefaultBranch(e: PolicyEvent): boolean {
  const branch = e.env.git?.branch;
  return branch !== undefined && defaultBranches(e).includes(branch);
}

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

function hitsDefaultBranch(e: PolicyEvent): boolean {
  const branches = defaultBranches(e);
  const onDefault = onDefaultBranch(e);
  return e.commands.some((c) => irreversibleGit(c) && (onDefault || pushesTo(c, branches)));
}

export default definePolicy({
  name: "default-branch-guard",
  version: 1,
  owner: "cyber-team",
  when: (e) => hitsDefaultBranch(e),
  decide: (e) => (e.session.mode === "headless" ? "deny" : "hold"),
  reason: "Irreversible git operation on the default branch.",
  detail: (e) =>
    `branch ${e.env.git?.branch ?? "unknown"}; default ${defaultBranches(e).join("/")}; mode ${e.session.mode ?? "unknown"}`,
  range: ["hold", "deny"],
});
