/**
 * The in-sandbox layout the compiler writes rules for (PLAN-M2 §4, D-107): HOME outside the
 * workspace, the adapter's files on read-only paths, the harness's own data dirs writable.
 * Host-controlled (the `[openshell]` table of step 3, or `cops openshell` flags); every
 * path is a path inside the sandbox, never on the host.
 */

/** The harnesses the compiler has a layout for. */
export const HARNESSES = ["claude-code", "pi"] as const;
/** One of {@link HARNESSES}. */
export type Harness = (typeof HARNESSES)[number];

/** Paths inside the sandbox. */
export interface SandboxLayout {
  /** HOME of the agent; must sit outside the workspace. */
  readonly home: string;
  /** The repository checkout the agent works in (`read_write`). */
  readonly workspace: string;
  /** Claude Code: the `cops-hook` binary its managed hook runs; the judge route's binary. */
  readonly hookBinary: string | null;
  /** Pi: the `jev-cops.ts` extension `pi -e` loads, from a read-only directory. */
  readonly extension: string | null;
  /**
   * Real paths (`readlink -f`) of the agent's executables; the task allowlist's binaries.
   * A rule applies to every process a listed binary starts (network-rules.mdx:71-73).
   */
  readonly agentBinaries: readonly string[];
  /** Pi: the real path of the node interpreter running the extension; the judge route's binary. */
  readonly interpreter: string | null;
  /** `process.run_as_user`/`run_as_group` (schema.mdx:86-96); null leaves them to the driver. */
  readonly runAs: { readonly user: string; readonly group: string } | null;
}

const RUN_AS = Object.freeze({ user: "1000", group: "1000" });

/**
 * The layout of the images step 9 builds: HOME `/home/agent`, workspace `/sandbox` (the
 * OpenShell sandbox directory), `cops-hook` under `/usr/local/libexec/jev-cops/`, Claude
 * Code at `/usr/local/bin/claude` (providers/claude-code.yaml:13-16), node at
 * `/usr/local/bin/node` for Pi (official Node.js images, network-rules.mdx:318-320), the Pi
 * extension under `/opt/jev-cops/`, UID/GID 1000.
 */
export function defaultLayout(harness: Harness): SandboxLayout {
  const common = { home: "/home/agent", workspace: "/sandbox", runAs: RUN_AS };
  if (harness === "claude-code") {
    return {
      ...common,
      hookBinary: "/usr/local/libexec/jev-cops/cops-hook",
      extension: null,
      agentBinaries: ["/usr/local/bin/claude"],
      interpreter: null,
    };
  }
  return {
    ...common,
    hookBinary: null,
    extension: "/opt/jev-cops/jev-cops.ts",
    agentBinaries: ["/usr/local/bin/node"],
    interpreter: "/usr/local/bin/node",
  };
}

/**
 * The one binary the judge route lists: the hook for Claude Code (its hook is a separate
 * process the agent's tools do not descend from), the interpreter for Pi (the extension
 * runs inside node, PLAN-M2 §2 row 9).
 */
export function judgeClient(harness: Harness, layout: SandboxLayout): string | null {
  return harness === "claude-code" ? layout.hookBinary : layout.interpreter;
}

/** The adapter's own files: protected like the judge's inputs (D-082), listed read-only. */
export function adapterPaths(layout: SandboxLayout): string[] {
  return [layout.hookBinary, layout.extension].filter((p): p is string => p !== null);
}

/** A path under HOME the harness writes by design, and why the kernel must let it. */
export interface WritableData {
  readonly path: string;
  readonly why: string;
}

/**
 * What each harness writes under HOME to work at all, beyond the annotate-tier rules of
 * `CONFIG_TREES` (PLAN-M2 §4 layout). These are not config: none is kill tier except the
 * one listed in {@link KERNEL_GAPS}.
 */
export const HARNESS_WRITABLE: Readonly<Record<Harness, readonly WritableData[]>> = Object.freeze({
  "claude-code": [
    { path: ".claude/projects", why: "session transcripts and project memory" },
    { path: ".claude.json", why: "trust flags, onboarding state, user-scope MCP servers" },
    { path: ".cache", why: "tool caches" },
    { path: ".npm", why: "the npm cache" },
  ],
  pi: [
    { path: ".pi/agent/sessions", why: "Pi session files" },
    { path: ".cache", why: "tool caches" },
    { path: ".npm", why: "the npm cache" },
  ],
});

/**
 * Kill-tier files the harness must be able to write, relative to HOME: the kernel cannot
 * protect them, so they stay with `config-tamper` (and Claude Code's ConfigChange hook).
 * Printed as gaps, never refused (PLAN-M2 §4: "the one config file the kernel cannot
 * protect").
 */
export const KERNEL_GAPS: Readonly<Record<Harness, readonly string[]>> = Object.freeze({
  "claude-code": [".claude.json"],
  pi: [],
});
