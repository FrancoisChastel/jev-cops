/**
 * Bypasses and limits of the Claude Code adapter that the hook cannot close (PLAN-M1 §5
 * residuals, docs/adapters.md#claude-code). `cops install claude-code` and `cops doctor`
 * print every one (spec: never silent).
 */
export const CLAUDE_CODE_GAPS: readonly string[] = [
  "A hook that cannot start (binary missing, not executable, path mistyped) is a non-blocking error: Claude Code runs the tool anyway, so the gate is silently disabled; `cops doctor` checks the registered path and runs a canary through it.",
  "A hook killed by the OS (SIGKILL, out of memory) or not started within the settings timeout (30 s) lets the call proceed; only OpenShell (M2) backstops it.",
  "No OpenShell: the agent runs with your permissions; config-tamper and the ConfigChange hook stop the settings and binary changes Claude Code sees, but every deny is best-effort until those files are read-only to the agent (T1, T4).",
  "`policy_settings` (managed settings) changes cannot be blocked by a hook; they are reported to copsd only.",
  "`kill` ends the turn (`continue: false`) and latches the session: every later call is denied and every later prompt blocked. Claude Code cannot be exited from a hook; `--fork-session` or a new session starts a new, unlatched root, and a `claude` started through Bash is its own root session.",
  "Hooks do not run under `--bare`, `--safe-mode`, `--setting-sources` without the install's source, `--settings '{\"disableAllHooks\": true}'`, `--restricted`, `allowManagedHooksOnly` (for a non-managed install), or in a folder whose workspace trust was not accepted (interactive); a managed install survives `--safe-mode`, `--restricted`, `--settings` and non-managed `disableAllHooks`.",
  "No PreToolUse fires for files referenced with `@` in a prompt, for `EndConversation`, or for commands the user types with `!`; cloud sessions and the VS Code and desktop surfaces are not verified.",
  "A hook `ask` against a bare `Bash` or `PowerShell` entry in `permissions.allow` is not documented (an exit-2 deny is documented to win); the installer refuses that allow rule unless `--force`.",
  "Another PreToolUse hook that returns `updatedInput` races jev-cops's rewrite: the last one to finish wins.",
  "The ask dialog is Claude Code's: next to jev-cops's reason, normalized command and detail it shows the tool input as Claude sent it, including the agent's own `description`.",
  "Headless is read from the parent `claude` argv (`-p`/`--print` without `--permission-prompt-tool`, through up to three shells). A parent that cannot be read or is not recognizably `claude` counts as headless, so holds are denied there; a launcher that runs `claude` without `-p` but with no human is taken for interactive, and its hold becomes an ask that a host-less run denies but shows, with jev-cops's command and detail, to Claude (seen on 2.1.280).",
  "Read, Glob, Grep and Claude Code's bookkeeping tools proceed when copsd is unreachable, with a warning and a line in ~/.jev-cops/claude-code-hook.log; every other tool, MCP tools included, is blocked.",
  "The hook sends no `env.git`; copsd derives repo, branch, default branch and dirty from the call's cwd, values the agent can steer in its own repository (D-067).",
  "Without OpenShell the agent can reach copsd's socket as you and post judge requests of its own; Claude Code holds carry no resolvable token, so no precedent comes from Claude Code in M1.",
  "A denied call produces no post event: Claude Code fires no PostToolUseFailure for a permission denial.",
  "`harness_version` is the `claude --version` recorded in ~/.jev-cops/claude-code.json by install or doctor; it is omitted until then (Claude Code gives hooks no version).",
  "Windows paths (backslash separators) are passed through unnormalized in M1.",
  "A managed install (`managed-settings.d/50-jev-cops.json`) is skipped without a warning when server-managed settings or an MDM profile supply the managed policy (default `managedSourcesBehavior` first-wins); `/status` names the source Claude Code applies.",
  "With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (v2.1.251+) hooks do not see `CLAUDE_CONFIG_DIR`, so the ConfigChange check looks for user settings in ~/.claude: a user install under `CLAUDE_CONFIG_DIR` then fails closed on every settings change (blocked, session latched).",
];
