/**
 * @jev-cops/adapter-claude-code: the Claude Code command hook (`cops-hook`). Translation
 * and fail-closed plumbing only; every decision is the daemon's (D-054). See
 * docs/adapters.md#claude-code.
 */
export * from "./args.ts";
export * from "./client.ts";
export * from "./deps.ts";
export * from "./events-pre.ts";
export * from "./events-session.ts";
export * from "./gaps.ts";
export * from "./hook.ts";
export * from "./hook-entries.ts";
export * from "./intact.ts";
export * from "./line-diff.ts";
export * from "./log.ts";
export * from "./mapper.ts";
export * from "./mode.ts";
export * from "./output.ts";
export * from "./payload.ts";
export * from "./process.ts";
export * from "./settings.ts";
export * from "./settings-io.ts";
export * from "./settings-merge.ts";
export * from "./state.ts";
export * from "./tools.ts";
export * from "./verdict.ts";
export * from "./version.ts";
