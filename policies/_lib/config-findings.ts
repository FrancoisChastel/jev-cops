import type { PolicyContext, PolicyEvent } from "@jev-cops/sdk";
import {
  ancestorTier,
  canon,
  killMarkers,
  maxTier,
  type PlacedTree,
  pathTier,
  placeTrees,
  projectRoots,
  type Tier,
} from "./config-trees.ts";
import { programOf } from "./program.ts";

/**
 * What a call does to the configuration trees (`config-trees.ts`), as `config-tamper`
 * findings: a non-read access to a tree path, the removal of a directory above one, a
 * kill-tier path named inside opaque code, a harness CLI changing its own config. The
 * judge's own guards are in `judge-guard.ts`.
 */

/** How a call reached what a finding is about. */
export type FindingHow =
  | "write"
  | "delete"
  | "exec"
  | "unknown"
  | "mention"
  | "cli"
  | "private"
  | "stop";

/** One reason the call matched: its tier, the path or text it is about, and how. */
export interface Finding {
  readonly tier: Tier;
  readonly target: string;
  readonly how: FindingHow;
}

/** What the tree findings read from `ctx.config`. */
export type TreeConfig = Pick<PolicyContext["config"], "home" | "protectedPaths">;

const HARNESS_CONFIG_VERB = "harness-config";
const HARNESS_CLIS: readonly string[] = ["claude", "codex", "opencode", "pi"];

/** The trees placed for this call: its cwd and repo, the daemon's home and protected paths. */
export function treesFor(e: PolicyEvent, config: TreeConfig): PlacedTree[] {
  return placeTrees({
    home: config.home,
    projectRoots: projectRoots(e.call.cwd, e.env.git?.repo, config.home),
    protectedPaths: config.protectedPaths,
  });
}

type Command = PolicyEvent["commands"][number];
/** A non-read access (reads never count). */
type Access = Exclude<PolicyEvent["fs"]["access"][string], "read">;

/** Non-read access to a tree path: write/delete take its tier; exec/unknown are capped at hold. */
function insideTier(path: string, how: Access, trees: readonly PlacedTree[]): Tier | null {
  const tier = pathTier(path, trees);
  return (how === "exec" || how === "unknown") && tier === "kill" ? "hold" : tier;
}

/** A command removing (`rm -r`), moving (`mv`) or re-moding (`chmod`, `chown`) a whole dir. */
function changesWhole(c: Command, how: Access): boolean {
  const program = programOf(c);
  const removes = program === "mv" || (program === "rm" && c.verbs.includes("recursive"));
  const remodes = program === "chmod" || program === "chown";
  return (how === "delete" && removes) || (how === "write" && remodes);
}

/** A directory above a tree root, removed, moved or re-moded as a whole: the trees' tier. */
function aboveTier(e: PolicyEvent, path: string, how: Access, trees: readonly PlacedTree[]) {
  const whole = e.commands.some((c) => c.paths.includes(path) && changesWhole(c, how));
  return whole ? ancestorTier(path, trees) : null;
}

/**
 * Non-read access to a tree path: write and delete take the path's tier; exec and unknown
 * (an effect the normalizer cannot prove: `jq … file`, `vim file`) are capped at hold.
 * A directory above a tree root (home, `/`, `~/.config`, the repo root, `/etc`) takes the
 * highest tier of the trees below it when a command removes it (`rm -r`), moves it away
 * (`mv`, its source) or changes its mode or owner (`chmod`, `chown`, `-R` or not). A write
 * into it (`mkdir -p`, `touch`, a copy, `tar -x`, `rsync`), a filtered delete (`find
 * -delete`, `git rm`), a delete that cannot remove a non-empty directory (`rm` without
 * `-r`, `rmdir`, `unlink`), unknown, exec and read access do not count.
 */
export function accessFindings(e: PolicyEvent, trees: readonly PlacedTree[]): Finding[] {
  return Object.entries(e.fs.access).flatMap(([path, how]): Finding[] => {
    if (how === "read") return [];
    const tier = maxTier([insideTier(path, how, trees), aboveTier(e, path, how, trees)]);
    return tier === null ? [] : [{ tier, target: path, how }];
  });
}

function isOpaque(e: PolicyEvent): boolean {
  const unread = e.kind === "other" && !e.verbs.includes("inert");
  return e.opaque.length > 0 || e.commands.some((c) => c.isInterpreter) || unread;
}

/**
 * An opaque call (an opaque span, an interpreter, a non-inert tool the normalizer cannot
 * read) whose text names a kill-tier path (`~`, `$HOME`, `${HOME}` expanded): hold.
 */
export function mentionFindings(e: PolicyEvent, config: TreeConfig): Finding[] {
  if (!isOpaque(e)) return [];
  const home = config.home;
  const text = canon(e.raw.replace(/\$\{HOME\}|\$HOME\b|~(?=[/\\])/g, home));
  const marker = killMarkers(config.protectedPaths).find((m) => text.includes(canon(m)));
  return marker === undefined ? [] : [{ tier: "hold", target: marker, how: "mention" }];
}

/** The harness CLI's own words (`claude mcp add`), past any wrapper (`env X=1 …`). */
function cliWords(argv: readonly string[]): string {
  const at = argv.findIndex((a) => HARNESS_CLIS.includes(a.slice(a.lastIndexOf("/") + 1)));
  return argv.slice(Math.max(at, 0), Math.max(at, 0) + 3).join(" ");
}

/** A harness CLI changing its config (the normalizer's `harness-config` verb): hold. */
export function harnessCliFindings(e: PolicyEvent): Finding[] {
  return e.commands
    .filter((c) => c.verbs.includes(HARNESS_CONFIG_VERB))
    .map((c) => ({ tier: "hold", target: cliWords(c.argv), how: "cli" }));
}
