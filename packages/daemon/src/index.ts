/**
 * @jevdict/daemon — `jevdictd`: the one process that judges (spec §Architecture). Unix
 * socket plus optional loopback HTTP, SQLite case files and precedents, the hash-chained
 * JSONL audit log, hot-reloaded policies, and the configured semantic judge.
 *
 * The Claude Code post-event mapper has its own entry, `@jevdict/daemon/claude-code/post`,
 * with no runtime dependency on `@jevdict/core`, so the hook binary can bundle it.
 */
export * from "./audit.ts";
export * from "./audit-payload.ts";
export * from "./config.ts";
export * from "./daemon.ts";
export * from "./git-probe.ts";
export * from "./holds.ts";
export * from "./kill-latch.ts";
export * from "./log.ts";
export * from "./policies.ts";
export * from "./precedents.ts";
export * from "./server.ts";
export * from "./session-facts.ts";
export * from "./session-route.ts";
export * from "./sessions.ts";
export * from "./verdict-map.ts";
