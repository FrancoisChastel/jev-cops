import { definePolicy, type PolicyContext, type PolicyEvent } from "@jevdict/sdk";

/**
 * config-tamper (spec §Starter policy set, T1; PLAN-M1 §4.5 as amended by §9): a call
 * that changes a harness's or jevdict's own configuration. Deterministic; asks nothing.
 *
 * Tiers, matched case-insensitively on absolute paths (`~` is the daemon's home,
 * `ctx.config.home`; project-relative entries are checked under the cwd, the repo root
 * and every directory above them, since the harness's project dir is one of those):
 * - kill: files that control hooks, permissions or extensions — Claude Code
 *   `settings.json`/`settings.local.json` (user and project), `~/.claude.json`, the
 *   managed-settings dirs, `hooks/`, `~/.claude/plugins/`; Codex `~/.codex/{config.toml,
 *   hooks.json,rules}` and a project's `.codex/`; OpenCode `plugin(s)/` dirs and
 *   `opencode.json[c]`; Pi `extensions/` and `settings.json`; jevdict's
 *   `~/.config/jevdict/`, `~/.jevdict/`, `.jevdict.toml`, and `ctx.config.protectedPaths`
 *   (the hook and daemon binaries, the daemon's policies dir);
 * - hold: instruction persistence and everything else under a harness config dir
 *   (`CLAUDE.md`/`AGENTS.md` there, `skills/`, `agents/`, `commands/`, `output-styles/`),
 *   and a project's `.mcp.json`;
 * - annotate: data the harness has the model write by design (`~/.claude/projects/*
 *   /memory/`, `~/.claude/plans/`, `~/.claude/todos/`);
 * - none: a Claude Code worktree under `.claude/worktrees/` (ordinary source files).
 *
 * Only non-read access counts (`e.fs.access`): write and delete take the tier; exec and
 * unknown (a command whose effect on the file is not known: `jq … file`, `vim file`) are
 * capped at hold. An opaque call (interpreter, eval, a tool the normalizer cannot read)
 * whose text names a kill-tier path, and a harness CLI changing config (the
 * `harness-config` verb), are held. Reads never match. Precedents never lower a kill
 * (D-035, enforced by the engine).
 */

type Tier = "annotate" | "hold" | "kill";
type RuleTier = Tier | "ignore";
type Anchor = "home" | "project" | "absolute";

/** A config tree: `root` under its anchor, the tier of anything in it, refinements below. */
interface Tree {
  readonly anchor: Anchor;
  readonly root: string;
  readonly rest: Tier;
  readonly rules?: Rules;
}

type Rules = Readonly<Record<string, RuleTier>>;

const CLAUDE_KILL: Rules = {
  "settings.json": "kill",
  "settings.local.json": "kill",
  hooks: "kill",
};
/** Claude Code data the model writes by design under `~/.claude/`. */
const HARNESS_DATA: Rules = {
  "projects/*/memory": "annotate",
  plans: "annotate",
  todos: "annotate",
};

const TREES: readonly Tree[] = [
  {
    anchor: "home",
    root: ".claude",
    rest: "hold",
    rules: { ...CLAUDE_KILL, plugins: "kill", ...HARNESS_DATA },
  },
  { anchor: "home", root: ".claude.json", rest: "kill" },
  {
    anchor: "home",
    root: ".codex",
    rest: "hold",
    rules: { "config.toml": "kill", "hooks.json": "kill", rules: "kill" },
  },
  {
    anchor: "home",
    root: ".config/opencode",
    rest: "hold",
    rules: { plugin: "kill", plugins: "kill", "opencode.json": "kill", "opencode.jsonc": "kill" },
  },
  {
    anchor: "home",
    root: ".pi",
    rest: "hold",
    rules: { "agent/extensions": "kill", "agent/settings.json": "kill" },
  },
  { anchor: "home", root: ".config/jevdict", rest: "kill" },
  { anchor: "home", root: ".jevdict", rest: "kill" },
  {
    anchor: "project",
    root: ".claude",
    rest: "hold",
    rules: { ...CLAUDE_KILL, worktrees: "ignore" },
  },
  { anchor: "project", root: ".codex", rest: "kill" },
  {
    anchor: "project",
    root: ".opencode",
    rest: "hold",
    rules: { plugin: "kill", plugins: "kill" },
  },
  { anchor: "project", root: "opencode.json", rest: "kill" },
  { anchor: "project", root: "opencode.jsonc", rest: "kill" },
  {
    anchor: "project",
    root: ".pi",
    rest: "hold",
    rules: { extensions: "kill", "settings.json": "kill" },
  },
  { anchor: "project", root: ".jevdict.toml", rest: "kill" },
  { anchor: "project", root: ".mcp.json", rest: "hold" },
  { anchor: "absolute", root: "/library/application support/claudecode", rest: "kill" },
  { anchor: "absolute", root: "/etc/claude-code", rest: "kill" },
  { anchor: "absolute", root: "/c/program files/claudecode", rest: "kill" },
];

/** Claude Code's Windows managed-settings dir, however a POSIX cwd was prefixed to it. */
const WINDOWS_MANAGED = "c:/program files/claudecode";
const RANK: Readonly<Record<Tier, number>> = { annotate: 0, hold: 1, kill: 2 };
const HARNESS_CONFIG_VERB = "harness-config";
const HARNESS_CLIS: readonly string[] = ["claude", "codex", "opencode", "pi"];

/** One reason the call matched: its tier, the path or text it is about, and how. */
interface Finding {
  readonly tier: Tier;
  readonly target: string;
  readonly how: "write" | "delete" | "exec" | "unknown" | "mention" | "cli";
}

/** A tree placed at one concrete base directory, lower-cased, with its rules split. */
interface Placed {
  readonly base: string;
  readonly rest: Tier;
  readonly rules: readonly { readonly segs: readonly string[]; readonly tier: RuleTier }[];
}

function canon(path: string): string {
  const slashed = path.replaceAll("\\", "/").toLowerCase();
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function segs(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

function join(base: string, rel: string): string {
  return rel.startsWith("/") ? rel : `${base === "/" ? "" : base}/${rel}`;
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let p = canon(path); p.startsWith("/"); p = p.slice(0, p.lastIndexOf("/")) || "/") {
    out.push(p);
    if (p === "/") break;
  }
  return out;
}

/** Where a project's harness config can live: the cwd, the repo root and every parent, never home. */
function projectRoots(e: PolicyEvent, home: string): string[] {
  const roots = [...ancestors(e.call.cwd), ...ancestors(e.env.git?.repo ?? "")];
  return [...new Set(roots)].filter((r) => r !== home);
}

function place(tree: Tree, base: string): Placed {
  const rules = Object.entries(tree.rules ?? {}).map(([rel, tier]) => ({ segs: segs(rel), tier }));
  return { base: canon(join(base, tree.root)), rest: tree.rest, rules };
}

/** Every tree at every base for this call, plus `ctx.config.protectedPaths` at kill. */
function placedTrees(e: PolicyEvent, ctx: PolicyContext): Placed[] {
  const home = canon(ctx.config.home);
  const roots = projectRoots(e, home);
  const extra: Tree[] = ctx.config.protectedPaths.map((root) => ({
    anchor: root.startsWith("/") ? "absolute" : "project",
    root: canon(root),
    rest: "kill",
  }));
  const basesOf = (a: Anchor): string[] =>
    a === "home" ? [home] : a === "project" ? roots : ["/"];
  return [...TREES, ...extra].flatMap((t) => basesOf(t.anchor).map((b) => place(t, b)));
}

function prefixOf(pattern: readonly string[], rel: readonly string[]): boolean {
  return pattern.length <= rel.length && pattern.every((s, i) => s === "*" || s === rel[i]);
}

/** The tier of `rel` inside a placed tree: the most specific rule, a dir holding a kill rule, or the rest. */
function tierIn(tree: Placed, rel: readonly string[]): Tier | null {
  const hits = tree.rules.filter((r) => prefixOf(r.segs, rel));
  const best = hits.toSorted((a, b) => b.segs.length - a.segs.length)[0];
  if (best !== undefined) return best.tier === "ignore" ? null : best.tier;
  const holdsKill = tree.rules.some((r) => r.tier === "kill" && prefixOf(rel, r.segs));
  return holdsKill ? "kill" : tree.rest;
}

function maxTier(tiers: readonly (Tier | null)[]): Tier | null {
  return tiers.reduce<Tier | null>(
    (m, t) => (t !== null && (m === null || RANK[t] > RANK[m]) ? t : m),
    null,
  );
}

function pathTier(path: string, trees: readonly Placed[]): Tier | null {
  const p = canon(path);
  if (p.includes(WINDOWS_MANAGED)) return "kill";
  const tiers = trees.map((t) => {
    if (p !== t.base && !p.startsWith(`${t.base}/`)) return null;
    return tierIn(t, segs(p.slice(t.base.length)));
  });
  return maxTier(tiers);
}

function accessFindings(e: PolicyEvent, trees: readonly Placed[]): Finding[] {
  return Object.entries(e.fs.access).flatMap(([path, how]): Finding[] => {
    if (how === "read") return [];
    const tier = pathTier(path, trees);
    if (tier === null) return [];
    const capped = (how === "exec" || how === "unknown") && tier === "kill" ? "hold" : tier;
    return [{ tier: capped, target: path, how }];
  });
}

/** Kill-tier paths as they can appear in code: home ones relative (`.claude.json`), the rest as is. */
function killMarkers(ctx: PolicyContext): string[] {
  const fromTrees = TREES.flatMap((t) => {
    const kills = Object.entries(t.rules ?? {}).filter(([, tier]) => tier === "kill");
    const own = t.rest === "kill" ? [t.root] : [];
    return [...own, ...kills.map(([rel]) => `${t.root}/${rel}`)];
  });
  return [...fromTrees, WINDOWS_MANAGED, ...ctx.config.protectedPaths.map(canon)];
}

function isOpaque(e: PolicyEvent): boolean {
  const unread = e.kind === "other" && !e.verbs.includes("inert");
  return e.opaque.length > 0 || e.commands.some((c) => c.isInterpreter) || unread;
}

function mentionFindings(e: PolicyEvent, ctx: PolicyContext): Finding[] {
  if (!isOpaque(e)) return [];
  const home = ctx.config.home;
  const text = canon(e.raw.replace(/\$\{HOME\}|\$HOME\b|~(?=[/\\])/g, home));
  const marker = killMarkers(ctx).find((m) => text.includes(canon(m)));
  return marker === undefined ? [] : [{ tier: "hold", target: marker, how: "mention" }];
}

/** The harness CLI's own words (`claude mcp add`), past any wrapper (`env X=1 …`). */
function cliWords(argv: readonly string[]): string {
  const at = argv.findIndex((a) => HARNESS_CLIS.includes(a.slice(a.lastIndexOf("/") + 1)));
  return argv.slice(Math.max(at, 0), Math.max(at, 0) + 3).join(" ");
}

function cliFindings(e: PolicyEvent): Finding[] {
  return e.commands
    .filter((c) => c.verbs.includes(HARNESS_CONFIG_VERB))
    .map((c) => ({ tier: "hold", target: cliWords(c.argv), how: "cli" }));
}

function findings(e: PolicyEvent, ctx: PolicyContext): Finding[] {
  const all = [
    ...accessFindings(e, placedTrees(e, ctx)),
    ...mentionFindings(e, ctx),
    ...cliFindings(e),
  ];
  return all.toSorted((a, b) => RANK[b.tier] - RANK[a.tier]);
}

function top(e: PolicyEvent, ctx: PolicyContext): Finding {
  return findings(e, ctx)[0] ?? { tier: "hold", target: "a configuration path", how: "write" };
}

function reasonFor(f: Finding): string {
  if (f.tier === "annotate") {
    return `Writing to ${f.target} changes data the harness manages; jevdict logged it.`;
  }
  switch (f.how) {
    case "cli":
      return `Running "${f.target}" would change the harness configuration.`;
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
  version: 1,
  owner: "cyber-team",
  when: (e, ctx) => findings(e, ctx).length > 0,
  decide: (e, ctx) => top(e, ctx).tier,
  reason: (e, ctx) => reasonFor(top(e, ctx)),
  contextNote: (e, ctx) =>
    `${top(e, ctx).target} is data the harness manages (memory, plans, todos); jevdict logged this write.`,
  detail: (e, ctx) =>
    findings(e, ctx)
      .map((f) => `${f.tier}: ${f.how} ${f.target}`)
      .join("; "),
  range: ["annotate", "kill"],
});
