import { definePolicy, type PolicyContext, type PolicyEvent } from "@jev-cops/sdk";
import {
  accessFindings,
  type Finding,
  harnessCliFindings,
  mentionFindings,
  treesFor,
} from "./_lib/config-findings.ts";
import { TIER_RANK } from "./_lib/config-trees.ts";
import { judgeCliFindings, privateReadFindings, stopFindings } from "./_lib/judge-guard.ts";

/**
 * config-tamper (spec §Starter policy set, T1; PLAN-M1 §4.5 as amended by §9): a call
 * that changes a harness's or jev-cops's own configuration. Deterministic; asks nothing.
 *
 * Tiers (kill: hooks, permissions, extensions, the judge's inputs; hold: everything else
 * under a harness config dir, a project's `.mcp.json`; annotate: the memory, plans and
 * todos Claude Code has the model write; none: a `.claude/worktrees/` checkout) come from
 * the configuration trees in `./_lib/config-trees.ts`, matched case-insensitively on
 * absolute paths under the daemon's home (`ctx.config.home`), each project root (the cwd,
 * the repo root and every directory above them) and absolute roots, plus
 * `ctx.config.protectedPaths` at kill (the hook and daemon binaries, the policies dir).
 *
 * Only non-read access counts (`e.fs.access`): write and delete take the tier; exec and
 * unknown (a command whose effect on the file is not known: `jq … file`, `vim file`) are
 * capped at hold. A directory above a tree root (home, `/`, `~/.config`, the repo root,
 * `/etc`) takes the highest tier below it, kill, when removed (`rm -r`), moved away (`mv`)
 * or re-moded (`chmod`, `chown`); a write into it, a filtered delete (`find -delete`) and
 * any other access to it do not count (`ls ~`, `touch ~/notes.txt`, `tar -x` in the repo).
 * An opaque call (interpreter, eval, a tool the normalizer cannot read) whose text names a
 * kill-tier path, and a harness CLI changing config (the `harness-config` verb), are held.
 * Precedents never lower a kill (D-035, the engine).
 *
 * The judge itself (M1 gate review, findings M2 and L1), held: any non-write access to
 * `ctx.config.privatePaths` (audit log, store, `~/.jev-cops/`: the scored decisions agent
 * channels never carry, T6), the agent running `cops explain|replay` (which print them),
 * `cops install` or `cops budget --reset` (`cops` as the command's program, past `sudo` or
 * `env` and inside `bash -c`; not a `cops` word: `echo cops explain`), and stopping `copsd`
 * or `cops-hook` by name (`pkill`/`killall` patterns, `kill $(pgrep …)`, a `launchctl`/
 * `systemctl` stop, each tool as the command's program: `echo pkill -f copsd` is not; a
 * bare pid is not recognized). Other reads never match.
 *
 * The trees are shared with the OpenShell compiler; the call's findings on them are in
 * `./_lib/config-findings.ts`, the judge's own guards in `./_lib/judge-guard.ts`.
 */

/** Every reason the call matched, highest tier first; equal tiers keep this order. */
function findings(e: PolicyEvent, ctx: PolicyContext): Finding[] {
  const all = [
    ...privateReadFindings(e, ctx.config.privatePaths),
    ...judgeCliFindings(e),
    ...accessFindings(e, treesFor(e, ctx.config)),
    ...mentionFindings(e, ctx.config),
    ...harnessCliFindings(e),
    ...stopFindings(e),
  ];
  return all.toSorted((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
}

function top(e: PolicyEvent, ctx: PolicyContext): Finding {
  return findings(e, ctx)[0] ?? { tier: "hold", target: "a configuration path", how: "write" };
}

function reasonFor(f: Finding): string {
  if (f.tier === "annotate") {
    return `Writing to ${f.target} changes data the harness manages; jev-cops logged it.`;
  }
  switch (f.how) {
    case "private":
      return f.target.startsWith("/")
        ? `Reading ${f.target} would expose the judge's internal record.`
        : `Running "${f.target}" would expose the judge's internal record.`;
    case "stop":
      return "Stopping the judge would block every later call.";
    case "cli":
      return `Running "${f.target}" would change the harness or judge configuration.`;
    case "mention":
      return `Code that names ${f.target} could change the harness or judge configuration.`;
    case "exec":
    case "unknown":
      return `This command on ${f.target} could change the harness or judge configuration.`;
    case "delete":
      return `Deleting ${f.target} would change the harness or judge configuration.`;
    default:
      return `Writing to ${f.target} would change the harness or judge configuration.`;
  }
}

export default definePolicy({
  name: "config-tamper",
  version: 4,
  owner: "cyber-team",
  when: (e, ctx) => findings(e, ctx).length > 0,
  decide: (e, ctx) => top(e, ctx).tier,
  reason: (e, ctx) => reasonFor(top(e, ctx)),
  contextNote: (e, ctx) =>
    `${top(e, ctx).target} is data the harness manages (memory, plans, todos); jev-cops logged this write.`,
  detail: (e, ctx) =>
    findings(e, ctx)
      .map((f) => `${f.tier}: ${f.how} ${f.target}`)
      .join("; "),
  range: ["annotate", "kill"],
});
